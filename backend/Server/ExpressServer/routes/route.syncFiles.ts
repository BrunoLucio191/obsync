import express, { type Request, type Response } from "express";
import type { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import fs from "node:fs/promises";
import { publishVaultChange } from "../../../syncEvents.ts";
import type { NextFunction } from "express";
import type { YjsCollaborationServer as YjsCollaborationGateway } from "../../../yjs/YjsCollaborationServer.ts";
import { QueueManager } from "../../../queue/QueueManager.ts";
import pathes from "node:path";

/** Vault sync endpoints mounted at `/api/sync`: the initial full-vault zip download
 * (`/initSync`, any authenticated role) and the admin-only structure mutations
 * (`/create`, `/delete`, `/modify`, `/rename`) that also broadcast a {@link VaultChange}
 * over the WebSocket for other connected clients. */
export type RouteSyncFilesContructor = {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  fileManager: FileManager;
  collaborationServer: YjsCollaborationGateway;
  queueManager: QueueManager;
};

export class RouteSyncFiles {
  public router: express.Router = express.Router();
  readonly #authMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  readonly #adminMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  readonly #clientIdMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  readonly #fileManager: FileManager;
  readonly #collaborationServer: YjsCollaborationGateway;
  readonly #queueManager: QueueManager;
  constructor({
    authMiddleware,
    adminMiddleware,
    clientIdMiddleware,
    fileManager,
    collaborationServer,
    queueManager,
  }: RouteSyncFilesContructor) {
    this.#authMiddleware = authMiddleware;
    this.#adminMiddleware = adminMiddleware;
    this.#clientIdMiddleware = clientIdMiddleware;
    this.#fileManager = fileManager;
    this.#collaborationServer = collaborationServer;
    this.#queueManager = queueManager;
  }

  /** Registers this router's routes on {@link router}. Must be called once before mounting. */
  public startRoute() {
    this.router.post(
      "/initSync",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response): Promise<void> => {
        const clientId = res.locals.clientId as string;
        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            console.log("[ZIP] Starting compression...");
            await this.#fileManager.directoryZiped();
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
        }, "vault:initSync");
      },
    );

    this.router.post(
      "/create",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response) => {
        const clientId = res.locals.clientId as string;
        const { path, isFolder, content } = req.body;

        if (typeof path !== "string" || !path.trim()) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }

        const pathDecoded = decodeURI(path);

        if (!pathDecoded.trim()) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            if (this.#collaborationServer.isPathDeleted(pathDecoded)) {
              await this.#collaborationServer.deletePersistedStateUnderPath(pathDecoded);
            }
            this.#collaborationServer.clearPathDeleted(pathDecoded);

            if (isFolder) {
              await this.#fileManager.createFolder(pathDecoded);
            } else {
              await this.#fileManager.createOrModifyFile(
                pathDecoded,
                typeof content === "string" ? content : "",
              );
            }
            //spread vault changes to the WebSocket
            publishVaultChange({
              type: "create",
              path: pathDecoded,
              isFolder: Boolean(isFolder),
              content: typeof content === "string" ? content : "",
              originClientId: clientId,
            });

            res.sendStatus(200);
          } catch (error) {
            console.error("[Sync] Error in Create:", error);
            res.status(500).json({ error: "Error creating file or folder" });
          }
        }, `file:${pathDecoded}:create`);
      },
    );

    this.router.delete(
      "/delete",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response) => {
        const clientId = res.locals.clientId as string;
        const { path, isFolder } = req.body;

        if (typeof path !== "string" || !path.trim()) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            this.#collaborationServer.markPathDeleted(path);
            try {
              await this.#fileManager.deletePath(path);
            } catch (error) {
              this.#collaborationServer.clearPathDeleted(path);
              throw error;
            }

            await this.#collaborationServer.deletePersistedStateUnderPath(path);
            publishVaultChange({
              type: "delete",
              path,
              isFolder: Boolean(isFolder),
              originClientId: clientId,
            });
            res.sendStatus(200);
          } catch (error) {
            console.error("[Sync] Error in Delete:", error);
            res.status(500).json({ error: "Error deleting" });
          }
        }, `file:${path}:delete`);
      },
    );

    this.router.put(
      "/modify",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response) => {
        const clientId = res.locals.clientId as string;
        const { path, content } = req.body;

        if (typeof path !== "string" || typeof content !== "string") {
          res.status(400).json({ error: "Invalid content or path" });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            if (this.#collaborationServer.isPathDeleted(path)) {
              res.status(409).json({ error: "The path was deleted" });
              return;
            }

            await this.#fileManager.createOrModifyFile(path, content);
            publishVaultChange({
              type: "modify",
              path,
              content,
              originClientId: clientId,
            });
            res.sendStatus(200);
          } catch (error) {
            console.error("[Sync] Error in Modify:", error);
            res.status(500).json({ error: "Error modifying file" });
          }
        }, `file:${path}:modify`);
      },
    );

    this.router.put(
      "/rename",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response) => {
        const clientId = res.locals.clientId as string;
        const { oldPath, newPath } = req.body;

        if (
          typeof oldPath !== "string" ||
          !oldPath.trim() ||
          typeof newPath !== "string" ||
          !newPath.trim()
        ) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }

        const queue = this.#queueManager.getOrCreateQueue(clientId);
        // Keyed on the source path: it is the resource that stops existing, and
        // locking both paths at once would open the door to a deadlock.
        queue.addTask(async () => {
          try {
            await this.#fileManager.rename(oldPath, newPath);
            await this.#collaborationServer.renamePersistedStatePath(oldPath, newPath);
            publishVaultChange({
              type: "rename",
              oldPath,
              newPath,
              originClientId: clientId,
            });
            res.sendStatus(200);
          } catch (error) {
            console.error("[Sync] Error in Rename:", error);
            res.status(500).json({ error: "Error renaming" });
          }
        }, `file:${oldPath}:rename`);
      },
    );
    this.router.post(
      "/createFile",
      this.#authMiddleware,
      this.#adminMiddleware,
      this.#clientIdMiddleware,
      express.raw({ limit: "50mb", type: "application/octet-stream" }),
      async (req: Request, res: Response) => {
        try {
          const clientId = res.locals.clientId as string;
          const buffer: ArrayBuffer = req.body;
          const nodeBuffer = Buffer.from(buffer);
          const { ["x-obsync-filepath"]: path } = req.headers;

          if (typeof path !== "string") {
            res.status(400).json({ error: "Invalid path" });
            return;
          }

          const queue = this.#queueManager.getOrCreateQueue(clientId);
          queue.addTask(
            async () => {
              try {
                if (nodeBuffer.byteLength == 0 || path == undefined) {
                  console.error("[Files] The task is empty or is missing an important field");
                  res.status(500).json({ error: "Error making file" });
                  return;
                }
                await this.#fileManager.createOrModifyFile(path, nodeBuffer);
              } catch (error) {
                console.error("[Sync] Error in Sending File");
                res.status(500).json({ error: "Error making file" });
                return;
              }
            },
            `file:${String(path)}:writeBinary`,
          );
          publishVaultChange({
            type: "create",
            path: String(path),
            isFolder: false,
            isBinary: true,
          });
          res.sendStatus(200);
        } catch (error) {
          console.error("[Sync] Error in Sending File");
          res.status(500).json({ error: "Error making file" });
          return;
        }
      },
    );
    this.router.get("/getFile", this.#authMiddleware, async (req: Request, res: Response) => {
      try {
        const { path, fileName } = req.query;
        const vaultPath = systemPaths.vault;

        const fileNameOrDirectory = path === fileName ? fileName : path;
        const relativo = pathes.join(vaultPath, String(fileNameOrDirectory));
        res.download(relativo, async (error) => {
          if (error) {
            console.error("[Sync] Error while sending the File", error);
          }
        });
      } catch (error) {
        console.error("[Sync] Error while sending the File", error);
        res.status(500).json({ error: "Error while sending the File" });
      }
    });
  }
}
