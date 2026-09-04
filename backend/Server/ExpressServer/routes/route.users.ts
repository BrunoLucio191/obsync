import express, { type Request, type Response, type NextFunction } from "express";
import type { TokenService } from "../../../auth/TokenService.ts";
import type { AuthenticatedUser, UserRole } from "../../../auth/auth.types.ts";
import { mutationErrorMessage, mutationErrorStatus } from "../mutationFunctions.ts";
import { DBServices } from "../../../users/DBServices.ts";
import type { QueueManager } from "../../../queue/QueueManager.ts";

export class RouteUsers {
  public router: express.Router = express.Router();
  constructor(
    private readonly tokenService: TokenService,
    private readonly dbService: DBServices,

    private readonly queueManager: QueueManager,
  ) {}

  private parseUserId(value: string | string[] | undefined): number | null {
    if (Array.isArray(value)) return null;
    const userId = Number(value);
    return userId > 0 ? userId : null;
  }

  private requestPath(req: Request): string | undefined {
    const value = req.body?.path ?? req.body?.oldPath ?? req.body?.newPath;
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
  }
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

  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }
  private requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.header("Authorization")?.replace(/^Bearer\s+/i, "");

    const authenticatedUser = await this.tokenService.verifyToken(token);

    if (!authenticatedUser) {
      res.status(401).json({ error: "Unauthorized." });

      return;
    }

    res.locals.authenticatedUser = authenticatedUser;
    res.locals.accessToken = token;
    next();
  };

  private requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.currentUser(res);

    if (user.role !== "admin") {
      this.auditDenied(user, req.method, req.path, this.requestPath(req));
      res.status(403).json({ error: "Only administrators can perform this action." });

      return;
    }

    next();
  };

  public startRoute() {
    this.router.patch(
      "/:id/name",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const normalizedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";

        if (!userId) {
          res.status(400).json({ error: "Invalid user." });
          return;
        }
        if (normalizedName.length < 2 || normalizedName.length > 64) {
          res.status(400).json({
            error: "The name must be between 2 and 64 characters.",
          });
          return;
        }
        const actor = this.currentUser(res);
        const target = await this.dbService.getUserById(userId, true);
        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            if (!target) {
              res.status(404).json({ error: "User not found." });
              return;
            }
            if (target.role === "admin" && target.id !== actor.id) {
              res.status(403).json({
                error: "Administrators can only change their own name.",
              });
              return;
            }

            const result = await this.dbService.updateUserName(userId, normalizedName);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`Something happened while changing ${userId} name`);
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

        if (!userId) {
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
        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            if (!target) {
              res.status(404).json({ error: "User not found." });
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
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`Something happened while changing ${userId} name`);

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
          res.status(400).json({ error: "The name must be between 2 and 64 characters." });
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          res.status(400).json({ error: "Enter a valid e-mail address." });
          return;
        }
        if (typeof password !== "string" || password.length < 6 || password.length > 128) {
          res.status(400).json({
            error: "The password must be between 6 and 128 characters.",
          });
          return;
        }
        const queue = this.queueManager.creatQueueOrReturn(email);

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
            console.error(`Something happened while creating a new user`);

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
          res.status(400).json({ error: "Invalid user or role." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserRole(userId, role);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while updating a user role");

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
          res.status(400).json({ error: "Invalid user or status." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserStatus(userId, active);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while updating a user status");

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
          res.status(400).json({ error: "Invalid user." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            const result = await this.dbService.deleteUser(userId);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while deleting a user ");

            res.status(500).json({
              error: "Something happened while deleting a user ",
            });
          }
        });
      },
    );
  }
}
