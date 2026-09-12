import { type Request, type Response } from "express";
import { QueueManager } from "../../../queue/QueueManager.ts";
import { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

export type SyncFilesControllerConstructor = {
  queueManager: QueueManager;
  fileManager: FileManager;
};
export class SyncFilesController {
  readonly #queueManager: QueueManager;
  readonly #fileManager: FileManager;
  constructor({ queueManager, fileManager }: SyncFilesControllerConstructor) {
    this.#queueManager = queueManager;
    this.#fileManager = fileManager;
  }

  /** custom implementation of promisify function */
  #downloadVault = async (zipPath: string, vaultZipName: string, res: Response): Promise<void> => {
    res.download(
      zipPath,
      vaultZipName,
      (error) =>
        new Promise((reject, resolve) => {
          if (error) reject(error);
          else resolve(true);
        }),
    );
  };

  syncFile = async (_req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const zipPath = systemPaths.vaultExit;
    const vaultZipName = clientId;

    const queue = this.#queueManager.getOrCreateQueue(clientId);
    const downlodFile = promisify(this.#downloadVault);

    queue.addTask(async () => {
      try {
        await this.#fileManager.directoryZiped(systemPaths.zips, clientId);
        await downlodFile(zipPath, vaultZipName, res);
        await fs.unlink(zipPath);
      } catch (error) {
        // TODO: handle res.headersSent when the download fails mid-stream
        res.status(500).json({ error: "[Zip] Internal error generating the file." });
        console.error("[Zip] Error sending the file");
      }
    }, "vault:InitSync");
  };
}
