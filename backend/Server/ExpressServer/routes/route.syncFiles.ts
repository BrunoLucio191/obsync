import express, { type Request, type Response } from "express";
import type { NextFunction } from "express";
import type { SyncFilesController } from "../controllers/SyncFilesController.ts";

export type RouteSyncFilesContructor = {
  authMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void>;
  adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  syncfilesController: SyncFilesController;
};

/**
 * Vault sync endpoints, mounted at `/api/sync` in ExpressServer.
 *
 * Full paths:
 * - POST   /api/sync/initSync               auth, clientId
 * - POST   /api/sync/create                 auth, admin, clientId
 * - DELETE /api/sync/delete                 auth, admin, clientId
 * - PUT    /api/sync/modify                 auth, admin, clientId
 * - PUT    /api/sync/rename                 auth, admin, clientId
 * - POST   /api/sync/createFile             auth, admin, clientId (raw body)
 * - GET    /api/sync/getFile?path&fileName  auth, clientId
 */
export class RouteSyncFiles {
  public router: express.Router = express.Router();
  readonly #authMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void>;
  readonly #adminMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;
  readonly #clientIdMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;
  readonly #syncFilesController: SyncFilesController;
  constructor({
    authMiddleware,
    adminMiddleware,
    clientIdMiddleware,
    syncfilesController,
  }: RouteSyncFilesContructor) {
    this.#authMiddleware = authMiddleware;
    this.#adminMiddleware = adminMiddleware;
    this.#clientIdMiddleware = clientIdMiddleware;
    this.#syncFilesController = syncfilesController;
  }

  /** Registers this router's routes on {@link router}. Must be called once before mounting. */
  public startRoute() {
    this.router.post(
      "/initSync",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.initSync,
    );
    this.router.post(
      "/create",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.create,
    );
    this.router.delete(
      "/delete",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.delete,
    );
    this.router.put(
      "/modify",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.modify,
    );
    this.router.put(
      "/rename",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.rename,
    );
    this.router.post(
      "/createFile",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      express.raw({ limit: "50mb", type: "application/octet-stream" }),
      this.#syncFilesController.createFile,
    );
    this.router.get(
      "/getFile",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      this.#syncFilesController.getFile,
    );
  }
}
