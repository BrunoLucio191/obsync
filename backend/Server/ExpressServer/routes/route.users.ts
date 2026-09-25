import express, { type Request, type Response, type NextFunction } from "express";
import type { UsersController } from "../controllers/UsersController.ts";

type RouteUsersContructor = {
  usersController: UsersController;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
};

/**
 * User management endpoints, mounted at `/api/users` in ExpressServer.
 *
 * Full paths:
 * - GET    /api/users               auth, admin
 * - POST   /api/users               auth, admin, clientId
 * - PATCH  /api/users/:id/name      auth, admin, clientId
 * - PATCH  /api/users/:id/password  auth, admin, clientId
 * - PATCH  /api/users/:id/role      auth, admin, clientId
 * - PATCH  /api/users/:id/status    auth, admin, clientId
 * - DELETE /api/users/:id           auth, admin, clientId
 */
export class RouteUsers {
  public router: express.Router = express.Router();
  readonly #usersController: UsersController;
  readonly #authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  readonly #adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  readonly #clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  constructor({
    usersController,
    authMiddleware,
    adminMiddleware,
    clientIdMiddleware,
  }: RouteUsersContructor) {
    this.#usersController = usersController;
    this.#authMiddleware = authMiddleware;
    this.#adminMiddleware = adminMiddleware;
    this.#clientIdMiddleware = clientIdMiddleware;
  }

  public startRoute() {
    this.router.get(
      "/",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#usersController.listUsers,
    );
    this.router.post(
      "/",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.createUser,
    );
    this.router.patch(
      "/:id/name",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.renameUser,
    );
    this.router.patch(
      "/:id/password",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.changePassword,
    );
    this.router.patch(
      "/:id/role",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.changeRole,
    );
    this.router.patch(
      "/:id/status",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.changeStatus,
    );
    this.router.delete(
      "/:id",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#usersController.deleteUser,
    );
  }
}
