import express, { type Request, type Response, type NextFunction } from "express";
import type { AuthenticatedUser, UserRole } from "../../../auth/auth.types.ts";
import {
  UserMutationErrorMessage,
  userMutationErrorStatus,
} from "./mutationMessage/userMessageMutation.ts";
import { DBServices } from "../../../users/DBServices.ts";
import type { QueueManager } from "../../../queue/QueueManager.ts";
type RouteUsersContructor = {
  dbService: DBServices;
  queueManager: QueueManager;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
};

export class RouteUsers {
  public router: express.Router = express.Router();
  readonly #dbService: DBServices;
  readonly #queueManager: QueueManager;
  readonly #authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  readonly #adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  readonly #clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  constructor({
    dbService,
    queueManager,
    authMiddleware,
    adminMiddleware,
    clientIdMiddleware,
  }: RouteUsersContructor) {
    this.#dbService = dbService;
    this.#queueManager = queueManager;
    this.#authMiddleware = authMiddleware;
    this.#adminMiddleware = adminMiddleware;
    this.#clientIdMiddleware = clientIdMiddleware;
  }

  /**
   * Parses and validates a route param as a positive user id.
   * @param value - The raw `:id` route param.
   * @returns The parsed id, or `null` if it's missing, an array, non-numeric, or not positive.
   */
  #parseUserId(value: string | string[] | undefined): number | null {
    if (Array.isArray(value)) return null;
    const userId = Number(value);
    return userId > 0 ? userId : null;
  }
  #currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  public startRoute() {
    this.router.patch(
      "/:id/name",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.#parseUserId(req.params.id);
        const normalizedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        const clientId = res.locals.clientId as string;

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

        const actor = this.#currentUser(res);
        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            const target = await this.#dbService.getUserById(userId, true);
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

            const result = await this.#dbService.updateUserName(userId, normalizedName);
            if (!result.ok) {
              res.status(userMutationErrorStatus(result)).json({
                error: UserMutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            res.status(500).json({
              error: "Something happened while changing some user name",
            });
          }
        }, `user:${userId}:renameUser`);
      },
    );

    this.router.patch(
      "/:id/password",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.#parseUserId(req.params.id);
        const newPassword = req.body?.newPassword;
        const clientId = res.locals.clientId as string;

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

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            const target = await this.#dbService.getUserById(userId, true);
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

            const result = await this.#dbService.adminSetUserPassword(userId, newPassword);
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
        }, `user:${userId}:changePassword`);
      },
    );

    this.router.get(
      "/",
      this.#authMiddleware,
      this.#adminMiddleware,
      async (_req: Request, res: Response): Promise<void> => {
        res.json({ users: await this.#dbService.listUsers() });
      },
    );

    this.router.post(
      "/",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const { name, email, password, role } = req.body ?? {};
        const normalizedName = typeof name === "string" ? name.trim() : "";
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
        const normalizedRole: UserRole = this.#dbService.isUserRole(role) ? role : "user";
        const clientId = res.locals.clientId as string;

        switch (true) {
          case normalizedName.length < 2 || normalizedName.length > 64:
            console.warn("[Users] Invalid name length (must be 2-64 characters)");
            res.status(400).json({ error: "The name must be between 2 and 64 characters." });
            return;
          case !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail):
            console.warn("[Users] Invalid name length (must be 2-64 characters)");
            res.status(400).json({ error: "Enter a valid e-mail address." });
            return;
          case typeof password !== "string" || password.length < 6 || password.length > 128:
            console.warn("[Users] Invalid password length (must be 6-128 characters)");
            res.status(400).json({
              error: "The password must be between 6 and 128 characters.",
            });
            return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            const result = await this.#dbService.createUser(
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
        }, `user:create:${normalizedEmail}`);
      },
    );

    this.router.patch(
      "/:id/role",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.#parseUserId(req.params.id);
        const clientId = res.locals.clientId as string;
        const role = req.body?.role;

        switch (true) {
          case !userId || !this.#dbService.isUserRole(role):
            console.warn("[Users] Invalid userId or role in request body");
            res.status(400).json({ error: "Invalid user or role." });
            return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            const result = await this.#dbService.updateUserRole(userId, role);
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
        }, `user:${userId}:changeRole`);
      },
    );

    this.router.patch(
      "/:id/status",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.#parseUserId(req.params.id);
        const active = req.body?.active;
        const clientId = res.locals.clientId as string;

        if (!userId || typeof active !== "boolean") {
          console.warn("[Users] Invalid userId or status in request body");
          res.status(400).json({ error: "Invalid user or status." });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            const result = await this.#dbService.updateUserStatus(userId, active);
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
        }, `user:${userId}:changeStatus`);
      },
    );

    this.router.delete(
      "/:id",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.#parseUserId(req.params.id);
        const clientId = res.locals.clientId as string;

        if (!userId) {
          console.warn("[Users] Missing or invalid userId in URL params");
          res.status(400).json({ error: "Invalid user." });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);

        queue.addTask(async () => {
          try {
            const result = await this.#dbService.deleteUser(userId);
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
        }, `user:${userId}:deleteUser`);
      },
    );
  }
}
