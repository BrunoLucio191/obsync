import { type Request, type Response } from "express";
import { QueueManager } from "../../../queue/QueueManager.ts";
import { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import type { YjsCollaborationServer } from "../../../yjs/YjsCollaborationServer.ts";

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
  constructor({ queueManager, fileManager, collaborationServer }: SyncFilesControllerConstructor) {
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

  syncFile = async (_req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const queue = this.#queueManager.getOrCreateQueue(clientId);

    try {
      await queue.addTask(async () => {
        await this.#fileManager.directoryZiped(systemPaths.zips, clientId);
        await this.#downloadVault(`${systemPaths.zips}/${clientId.trim()}.zip`, clientId, res);
        setTimeout(async () => {
          await fs.unlink(`${systemPaths.zips}/${clientId.trim()}.zip`);
        }, 15_000);
      }, "vault:InitSync");
    } catch (error) {
      // TODO: handle res.headersSent when the download fails mid-stream
      res.status(500).json({ error: "[Zip] Internal error generating the file." });
      console.error("[Zip] Error sending the file");
    }
  };
}
