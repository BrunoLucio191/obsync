import express, { type Request, type Response } from "express";
import { TokenService } from "../../../auth/TokenService.ts";
import type { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import fs from "node:fs/promises";
import { publishVaultChange } from "../../../syncEvents.ts";
import type { NextFunction } from "express";
import type { AuthenticatedUser } from "../../../auth/auth.types.ts";
import type { YjsCollaborationServer as YjsCollaborationGateway } from "../../../yjs/YjsCollaborationServer.ts";

/** Vault sync endpoints mounted at `/api/sync`: the initial full-vault zip download
 * (`/initSync`, any authenticated role) and the admin-only structure mutations
 * (`/create`, `/delete`, `/modify`, `/rename`) that also broadcast a {@link VaultChange}
 * over the WebSocket for other connected clients. */
export type RouteSyncFilesContructor = {
  tokenService: TokenService;
  fileManager: FileManager;
  collaborationServer: YjsCollaborationGateway;
};

export class RouteSyncFiles {
  public router: express.Router = express.Router();
  private readonly tokenService: TokenService;
  private readonly fileManager: FileManager;
  private readonly collaborationServer: YjsCollaborationGateway;
  constructor({ tokenService, fileManager, collaborationServer }: RouteSyncFilesContructor) {
    this.tokenService = tokenService;
    this.fileManager = fileManager;
    this.collaborationServer = collaborationServer;
  }

  /** Reads the authenticated user previously attached to the request by {@link requireAuth}. */
  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  /** Middleware: rejects the request with 403 (and logs an audit entry) unless the
   * authenticated user is an admin. Must run after {@link requireAuth}. */
  private requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.currentUser(res);

    if (user.role !== "admin") {
      this.auditDenied(user, req.method, req.path, this.requestPath(req));
      res.status(403).json({ error: "Only administrators can perform this action." });

      return;
    }

    next();
  };

  /** Middleware: resolves the bearer access token and rejects the request with 401 if it's
   * missing/invalid. Must run before {@link requireAdmin} or any route reading
   * {@link currentUser}. */
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

  /** Extracts the vault path an audited request targeted (`path`, `oldPath`, or `newPath`),
   * normalizing slashes, for {@link auditDenied} log entries. */
  private requestPath(req: Request): string | undefined {
    const value = req.body?.path ?? req.body?.oldPath ?? req.body?.newPath;
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
  }

  /** Registers this router's routes on {@link router}. Must be called once before mounting. */
  public startRoute() {
    this.router.post(
      "/initSync",
      this.requireAuth,
      async (_req: Request, res: Response): Promise<void> => {
        try {
          console.log("[ZIP] Starting compression...");
          await this.fileManager.directoryZiped();
          const zipPath = systemPaths.vaultExit;

          res.download(zipPath, "vault.zip", async (error) => {
            if (error) {
              console.error("[ZIP] Error sending file:", error.message);
              if (!res.headersSent) {
                res.status(500).json({ error: "Failed to send the files." });
              }
            } else {
              console.log("[ZIP] Sent successfully.");
            }

            try {
              await fs.unlink(zipPath);
            } catch (error) {
              console.error("[ZIP] Error cleaning up temporary file:", error);
            }
          });
        } catch (error) {
          console.error("[ZIP] General error:", error);
          res.status(500).json({ error: "Internal error generating the file." });
        }
      },
    );

    this.router.post(
      "/create",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response) => {
        try {
          const { path, isFolder, content } = req.body;

          if (typeof path !== "string" || !path.trim()) {
            res.status(400).send("Invalid path");
            return;
          }

          if (this.collaborationServer.isPathDeleted(path)) {
            await this.collaborationServer.deletePersistedStateUnderPath(path);
          }
          this.collaborationServer.clearPathDeleted(path);

          if (isFolder) {
            await this.fileManager.createFolder(path);
          } else {
            await this.fileManager.createOrModifyFile(
              path,
              typeof content === "string" ? content : "",
            );
          }

          //spread vault changes to the WebSocket
          publishVaultChange({
            type: "create",
            path,
            isFolder: Boolean(isFolder),
            content: typeof content === "string" ? content : "",
            originClientId: req.header("x-obsync-client") ?? undefined,
          });

          res.sendStatus(200);
        } catch (error) {
          console.error("[Sync] Error in Create:", error);
          res.status(500).send("Error creating file or folder");
        }
      },
    );

    this.router.delete(
      "/delete",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response) => {
        try {
          const { path, isFolder } = req.body;
          if (typeof path !== "string" || !path.trim()) {
            res.status(400).send("Invalid path");
            return;
          }

          this.collaborationServer.markPathDeleted(path);
          try {
            await this.fileManager.deletePath(path);
          } catch (error) {
            this.collaborationServer.clearPathDeleted(path);
            throw error;
          }

          await this.collaborationServer.deletePersistedStateUnderPath(path);
          publishVaultChange({
            type: "delete",
            path,
            isFolder: Boolean(isFolder),
            originClientId: req.header("x-obsync-client") ?? undefined,
          });
          res.sendStatus(200);
        } catch (error) {
          console.error("[Sync] Error in Delete:", error);
          res.status(500).send("Error deleting");
        }
      },
    );

    this.router.put(
      "/modify",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response) => {
        try {
          const { path, content } = req.body;
          if (typeof path !== "string" || typeof content !== "string") {
            res.status(400).send("Invalid content or path");
            return;
          }
          if (this.collaborationServer.isPathDeleted(path)) {
            res.status(409).send("The path was deleted");
            return;
          }

          await this.fileManager.createOrModifyFile(path, content);
          publishVaultChange({
            type: "modify",
            path,
            content,
            originClientId: req.header("x-obsync-client") ?? undefined,
          });
          res.sendStatus(200);
        } catch (error) {
          console.error("[Sync] Error in Modify:", error);
          res.status(500).send("Error modifying file");
        }
      },
    );

    this.router.put(
      "/rename",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response) => {
        try {
          const { oldPath, newPath } = req.body;
          if (
            typeof oldPath !== "string" ||
            !oldPath.trim() ||
            typeof newPath !== "string" ||
            !newPath.trim()
          ) {
            res.status(400).send("Invalid path");
            return;
          }

          await this.fileManager.rename(oldPath, newPath);
          await this.collaborationServer.renamePersistedStatePath(oldPath, newPath);
          publishVaultChange({
            type: "rename",
            oldPath,
            newPath,
            originClientId: req.header("x-obsync-client") ?? undefined,
          });
          res.sendStatus(200);
        } catch (error) {
          console.error("[Sync] Error in Rename:", error);
          res.status(500).send("Error renaming");
        }
      },
    );
    //TODO: add route for making a file
    this.router.get(
      "/createFile",
      this.requireAuth,
      this.requireAdmin,
      async (req: Request, res: Response) => {
        try {
          const doingNothing = null;
        } catch (error) {
          console.error();
          res.status(500).send("Error making file");
        }
      },
    );
  }
}
