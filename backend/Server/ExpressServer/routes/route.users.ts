import express, { type Request, type Response, type NextFunction } from "express";
import type { TokenService } from "../../../auth/TokenService.ts";
import type { AuthenticatedUser, UserRole } from "../../../auth/auth.types.ts";
import {
  UserMutationErrorMessage,
  userMutationErrorStatus,
} from "./mutationMessage/userMessageMutation.ts";
import { DBServices } from "../../../users/DBServices.ts";
import type { QueueManager } from "../../../queue/QueueManager.ts";

/** Admin-only user management endpoints mounted at `/api/users`: list, create, rename,
 * reset password, change role, activate/deactivate, and delete. Every mutation runs on a
 * per-target-user {@link QueueManager} queue so concurrent requests for the same user
 * serialize instead of racing. */

type RouteUsersContructor = {
  tokenService: TokenService;
  dbService: DBServices;
  queueManager: QueueManager;
};

export class RouteUsers {
  public router: express.Router = express.Router();
  private readonly tokenService: TokenService;
  private readonly dbService: DBServices;
  private readonly queueManager: QueueManager;
  constructor({ tokenService, dbService, queueManager }: RouteUsersContructor) {
    this.tokenService = tokenService;
    this.dbService = dbService;
    this.queueManager = queueManager;
  }

  /**
   * Parses and validates a route param as a positive user id.
   * @param value - The raw `:id` route param.
   * @returns The parsed id, or `null` if it's missing, an array, non-numeric, or not positive.
   */
  private parseUserId(value: string | string[] | undefined): number | null {
    if (Array.isArray(value)) return null;
    const userId = Number(value);
    return userId > 0 ? userId : null;
  }

  /** Extracts the vault path an audited request targeted (`path`, `oldPath`, or `newPath`),
   * normalizing slashes, for {@link auditDenied} log entries. */
  private requestPath(req: Request): string | undefined {
    const value = req.body?.path ?? req.body?.oldPath ?? req.body?.newPath;
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
  }

  /** Logs an audit warning for an operation denied by {@link requireAdmin}. */
  private auditDenied(
    user: AuthenticatedUser,
    operation: string,
    route: string,
    targetPath?: string,
  ): void {
    console.warn("[Audit] Global operation blocked", {
      userId: user.id,
      role: user.role,
      operation,
      route,
      path: targetPath,
      timestamp: new Date().toISOString(),
      allowed: false,
    });
  }

  /** Reads the authenticated user previously attached to the request by {@link requireAuth}. */
  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  /** Middleware: resolves the bearer access token and rejects the request with 401 if it's
   * missing/invalid. Must run before {@link requireAdmin} or any route reading
   * {@link currentUser}. */
  private requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.header("Authorization")?.replace(/^Bearer\s+/i, "");

    const authenticatedUser = await this.tokenService.verifyToken(token);

    if (!authenticatedUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    res.locals.authenticatedUser = authenticatedUser;
    res.locals.accessToken = token;
    next();
  };

  /** Middleware: rejects the request with 403 (and logs an audit entry) unless the
   * authenticated user is an admin. Must run after {@link requireAuth}. */
  private requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.currentUser(res);

    if (user.role !== "admin") {
      this.auditDenied(user, req.method, req.path, this.requestPath(req));
      res.status(403).json({ error: "[Users] Only administrators can perform this action." });

      return;
    }

    next();
  };

  /** Registers this router's routes on {@link router}. Must be called once before mounting. */
  public startRoute() {
    this.router.patch(
      "/:id/name",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const { ["x-obsync-client"]: clientId } = req.headers;
        const normalizedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";

        if (!userId) {
          console.warn("[Users] Missing or invalid userId in URL params");
          res.status(404).json({ error: "Invalid user." });
          return;
        }

        if (normalizedName.length < 2 || normalizedName.length > 64) {
          console.warn("[Users] Invalid name length (must be 2-64 characters)");
          res.status(400).json({
            error: "The name must be between 2 and 64 characters.",
          });
          return;
        }
        const actor = this.currentUser(res);
        const target = await this.dbService.getUserById(userId, true);
        const queue = this.queueManager.creatDBQueueOrReturn(String(clientId));

        queue.addTask(async () => {
          try {
            if (!target) {
              console.warn("[Users] Target user not found");
              res.status(404).json({ error: "User not found." });
              return;
            }
            if (target.role === "admin" && target.id !== actor.id) {
              console.warn("[Users] Only admins can change their own name");
              res.status(403).json({
                error: "Administrators can only change their own name.",
              });
              return;
            }

            const result = await this.dbService.updateUserName(userId, normalizedName);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`[Users] An error happened while changing the ${userId} name`, error);
            res.status(500).json({
              error: "Something happened while changing some user name",
            });
          }
        });
      },
    );

    this.router.patch(
      "/:id/password",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const newPassword = req.body?.newPassword;
        const { ["x-obsync-client"]: clientId } = req.headers;

        if (!userId) {
          console.warn("[Users] Missing or invalid userId in URL params");
          res.status(400).json({ error: "Invalid user." });
          return;
        }
        if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 128) {
          res.status(400).json({
            error: "The new password must be between 6 and 128 characters.",
          });
          return;
        }

        const target = await this.dbService.getUserById(userId, true);
        const queue = this.queueManager.creatDBQueueOrReturn(String(clientId));

        queue.addTask(async () => {
          try {
            if (!target) {
              res.status(404).json({
                error: "User not found in DB",
              });
              return;
            }
            if (target.role !== "user") {
              res.status(403).json({
                error:
                  "Administrators can only reset a regular user's password. " +
                  "Use the self-service password change for your own account.",
              });
              return;
            }

            const result = await this.dbService.adminSetUserPassword(userId, newPassword);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`[Users] Something happened while changing ${userId} name`, error);

            res.status(500).json({
              error: "Something happened while changing some user password",
            });
          }
        });
      },
    );

    this.router.get(
      "/",
      this.requireAuth,
      this.requireAdmin,
      async (_req: Request, res: Response): Promise<void> => {
        res.json({ users: await this.dbService.listUsers() });
      },
    );

    this.router.post(
      "/",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const { name, email, password, role } = req.body ?? {};
        const normalizedName = typeof name === "string" ? name.trim() : "";
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
        const normalizedRole: UserRole = this.dbService.isUserRole(role) ? role : "user";

        if (normalizedName.length < 2 || normalizedName.length > 64) {
          console.warn("[Users] Invalid name length (must be 2-64 characters)");
          res.status(400).json({ error: "The name must be between 2 and 64 characters." });
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          res.status(400).json({ error: "Enter a valid e-mail address." });
          return;
        }
        if (typeof password !== "string" || password.length < 6 || password.length > 128) {
          console.warn("[Users] Invalid password length (must be 6-128 characters)");
          res.status(400).json({
            error: "The password must be between 6 and 128 characters.",
          });
          return;
        }
        const queue = this.queueManager.creatDBQueueOrReturn(email);

        queue.addTask(async () => {
          try {
            const result = await this.dbService.createUser(
              normalizedName,
              normalizedEmail,
              password,
              normalizedRole,
            );
            if (!result.ok) {
              res.status(409).json({
                error:
                  result.reason === "email_exists"
                    ? "A user with that e-mail already exists."
                    : "A user with that name already exists.",
                reason: result.reason,
              });
              return;
            }
            res.status(201).json({ user: result.user });
          } catch (error) {
            console.error(`[Users] Something happened while creating a new user`, error);
            res.status(500).json({
              error: "Something happened while creating a new user",
            });
          }
        });
      },
    );

    this.router.patch(
      "/:id/role",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const role = req.body?.role;
        if (!userId || !this.dbService.isUserRole(role)) {
          console.warn("[Users] Invalid userId or role in request body");
          res.status(400).json({ error: "Invalid user or role." });
          return;
        }

        const queue = this.queueManager.creatDBQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserRole(userId, role);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("[Users] Something happened while updating a user role", error);
            res.status(500).json({
              error: "Something happened while updating a user role",
            });
          }
        });
      },
    );

    this.router.patch(
      "/:id/status",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const active = req.body?.active;

        if (!userId || typeof active !== "boolean") {
          console.warn("[Users] Invalid userId or status in request body");
          res.status(400).json({ error: "Invalid user or status." });
          return;
        }

        const queue = this.queueManager.creatDBQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserStatus(userId, active);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("[Users] Something happened while updating a user status", error);

            res.status(500).json({
              error: "Something happened while updating a user status",
            });
          }
        });
      },
    );

    this.router.delete(
      "/:id",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        if (!userId) {
          console.warn("[Users] Missing or invalid userId in URL params");
          res.status(400).json({ error: "Invalid user." });
          return;
        }

        const queue = this.queueManager.creatDBQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            const result = await this.dbService.deleteUser(userId);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("[Users] Something happened while deleting a user ", error);

            res.status(500).json({
              error: "Something happened while deleting a user ",
            });
          }
        });
      },
    );
  }
}
