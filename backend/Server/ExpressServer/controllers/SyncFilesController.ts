import { type Request, type Response } from "express";
import { QueueManager } from "../../../queue/QueueManager.ts";
import { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import * as fs from "node:fs/promises";

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
  #downloadVault = async (
    zipPath: string,
    vaultZipName: string,
    res: Response,
  ): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers();
    res.download(zipPath, vaultZipName, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
    return promise;
  };

  syncFile = async (_req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const zipPath = systemPaths.vaultExit;
    const vaultZipName = "vault.zip";

    const queue = this.#queueManager.getOrCreateQueue(clientId);

    queue.addTask(async () => {
      try {
        await this.#fileManager.directoryZiped();
        await this.#downloadVault(zipPath, vaultZipName, res);
        await fs.unlink(zipPath);
      } catch (error) {
        res.status(500).json({ error: "[Zip] Internal error generating the file." });
        console.error("[Zip] Error sending the file");
      }
    }, "vault:InitSync");
  };
}
