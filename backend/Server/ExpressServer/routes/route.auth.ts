import express, { type Request, type Response } from "express";
import type { AuthService } from "../../../auth/authService.ts";
import type { NextFunction } from "express";
import { AuthController } from "../controllers/AuthController.ts";

type RouteAuthConstructor = {
  authService: AuthService;
  authController: AuthController;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
};

/** Session endpoints mounted at `/api/auth`: login, refresh, logout, current user, WebSocket
 * ticket issuance, and self-service password change. */
export class RouteAuth {
  public router: express.Router = express.Router();
  readonly #authController: AuthController;
  readonly #authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  readonly #clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  constructor({ authController, authMiddleware, clientIdMiddleware }: RouteAuthConstructor) {
    this.#authController = authController;
    this.#authMiddleware = authMiddleware;
    this.#clientIdMiddleware = clientIdMiddleware;
  }

  public startRoute() {
    this.router.post("/login", this.#authController.login);
    this.router.post("/refresh", this.#authController.refreash);
    this.router.post("/logout", this.#authController.logout);
    this.router.get("/me", this.#authMiddleware, this.#authController.me);
    this.router.post("/ws-ticket", this.#authMiddleware, this.#authController.wsTicket);
    this.router.post(
      "/change-password",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      this.#authController.changePassword,
    );
  }
}
