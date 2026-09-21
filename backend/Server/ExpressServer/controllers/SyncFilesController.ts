import { type Request, type Response } from "express";
import { QueueManager } from "../../../queue/QueueManager.ts";
import { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import * as fs from "node:fs/promises";
import type { YjsCollaborationServer } from "../../../yjs/YjsCollaborationServer.ts";
import { publishVaultChange } from "../../../syncEvents.ts";

export type SyncFilesControllerConstructor = {
  queueManager: QueueManager;
  fileManager: FileManager;
  collaborationServer: YjsCollaborationServer;
};
// TODO: finish this controller. The sync file flow is still implemented in
// routes/route.syncFiles.ts and should move here, leaving the route only wiring
// middlewares to controller methods, the same way it was done for UsersController.
export class SyncFilesController {
  readonly #queueManager: QueueManager;
  readonly #fileManager: FileManager;
  readonly #collaborationServer: YjsCollaborationServer;
  constructor({
    queueManager,
    fileManager,
    collaborationServer,
  }: SyncFilesControllerConstructor) {
    this.#queueManager = queueManager;
    this.#fileManager = fileManager;
    this.#collaborationServer = collaborationServer;
  }

  /** custom implementation of promisify function */
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

  initSync = async (_req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const queue = this.#queueManager.getOrCreateQueue(clientId);

    try {
      await queue.addTask(async () => {
        await this.#fileManager.directoryZiped(systemPaths.zips, clientId);
        await this.#downloadVault(
          `${systemPaths.zips}/${clientId.trim()}.zip`,
          clientId,
          res,
        );
        setTimeout(async () => {
          await fs.unlink(`${systemPaths.zips}/${clientId.trim()}.zip`);
        }, 15_000);
      }, "vault:InitSync");
    } catch (error) {
      // TODO: handle res.headersSent when the download fails mid-stream
      res.status(500).json({ error: "[Zip] Internal error generating the file." });
      console.error("[Zip] Error sending the file");
      return
    }
  };
  create = async (req: Request, res: Response): Promise<void> => {
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
    try {
      await queue.addTask(async () => {
        if (this.#collaborationServer.isPathDeleted(pathDecoded)) {
          await this.#collaborationServer.deletePersistedStateUnderPath(
            pathDecoded,
          );
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

        publishVaultChange({
          type: "create",
          path: pathDecoded,
          isFolder: Boolean(isFolder),
          content: typeof content === "string" ? content : "",
          originClientId: clientId,
        });
        res.sendStatus(200);
      }, `file:${pathDecoded}:create`);
    } catch (error) {
      console.error("[Sync] Error in Create:", error);
      res.status(500).json({ error: "Error creating file or folder" });
      return;
    }
  };
  delete = async (req: Request, res: Response) => {
    const clientId = res.locals.clientId as string;
    const { path, isFolder } = req.body;

    if (typeof path !== "string" || !path.trim()) {
      res.status(400).json({ erro: "Invalid Path" });
      return;
    }
    const queue = this.#queueManager.getOrCreateQueue(clientId);
    try {
      queue.addTask(async () => {
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
      }, `file:${path}:delete`);
    } catch (error) {
      console.error("[Sync] Error in Delete:", error);
      res.status(500).json({ error: "Error deleting" });
      return;
    }
  }
  modify = async (req: Request, res: Response) => {
    const cliendId = res.locals.cliendId as string;
    const { path, content } = req.body;

    if (typeof path !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "Invalid content or path" });
      return;
    }

    const queue = this.#queueManager.getOrCreateQueue(cliendId);
  }
}
