import express, { type Request, type Response } from "express";
import type { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import fs from "node:fs/promises";
import { publishVaultChange } from "../../../syncEvents.ts";
import type { NextFunction } from "express";
import type { YjsCollaborationServer as YjsCollaborationGateway } from "../../../yjs/YjsCollaborationServer.ts";
import { QueueManager } from "../../../queue/QueueManager.ts";
import pathes from "node:path";

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
  #downloadVault = (zipPath: string, vaultZipName: string, res: Response) => {
    return new Promise((resolve, reject) => {
      res.download(zipPath, `${vaultZipName}.zip`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  };
  //TODO:: add a dynamic time for the timeout based on the size of the vault
  /** Registers this router's routes on {@link router}. Must be called once before mounting. */
  public startRoute() {
    this.router.post(
      "/initSync",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      async (_req: Request, res: Response): Promise<void> => {
        const clientId = res.locals.clientId as string;
        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            await this.#fileManager.directoryZiped(systemPaths.zips, clientId);
            await this.#downloadVault(`${systemPaths.zips}/${clientId.trim()}.zip`, clientId, res);
          } catch (error) {
            // TODO: handle res.headersSent when the download fails mid-stream
            res.status(500).json({ error: "[Zip] Internal error generating the file." });
            console.error("[Zip] Error sending the file", error);
          }
          setTimeout(async () => {
            await fs.unlink(`${systemPaths.zips}/${clientId.trim()}.zip`);
          }, 15_000);
        }, "vault:InitSync");
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

        console.log("recebe");
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
            await this.#collaborationServer.renamePersistedStatePath(oldPath, newPath);
            await this.#fileManager.rename(oldPath, newPath);
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
        }, `file:${newPath}:rename`);
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
              publishVaultChange({
                type: "create",
                path: String(path),
                isFolder: false,
                isBinary: true,
              });
              res.sendStatus(200);
            },
            `file:${String(path)}:writeBinary`,
          );
        } catch (error) {
          console.error("[Sync] Error in Sending File");
          res.status(500).json({ error: "Error making file" });
          return;
        }
      },
    );
    this.router.get(
      "/getFile",
      this.#authMiddleware,
      this.#clientIdMiddleware,
      async (req: Request, res: Response) => {
        const { path, fileName } = req.query;
        const clientId = res.locals.clienId as string;
        const vaultPath = systemPaths.vault;
        const fileNameOrDirectory = path === fileName ? fileName : path;
        const relativo = pathes.join(vaultPath, String(fileNameOrDirectory));
        const queue = this.#queueManager.getOrCreateQueue(clientId);
        queue.addTask(async () => {
          try {
            await this.#downloadVault(relativo, clientId, res);
          } catch (error) {
            // TODO: handle res.headersSent when the download fails mid-stream
            console.error("[Sync] Error while sending the File", error);
            res.status(500).json({ error: "Error while sending the File" });
          }
        }, `file:${fileNameOrDirectory}:send`);
      },
    );
  }
}
