import { type Request, type Response } from "express";
import { QueueManager } from "../../../queue/QueueManager.ts";
import { FileManager } from "../../FileManager.ts";
import { systemPaths } from "../../../paths.ts";
import * as fs from "node:fs/promises";
import pathes from "node:path";
import type { YjsCollaborationServer } from "../../../yjs/YjsCollaborationServer.ts";
import { publishVaultChange } from "../../../syncEvents.ts";

export type SyncFilesControllerConstructor = {
  queueManager: QueueManager;
  fileManager: FileManager;
  collaborationServer: YjsCollaborationServer;
};

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

  /**
   * Current gene of the canonical vault as a single-line JSON string, or `null` when the
   * gene file is missing or not valid JSON (for example while it is being rewritten).
   */
  async #readVaultGene(): Promise<string | null> {
    try {
      const raw = await fs.readFile(systemPaths.vaultGene, "utf8");
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  //TODO:: add a dynamic time for the timeout based on the size of the vault
  /**
   * Sends the whole vault as a zip, unless the gene the client got from its last complete
   * initial sync (`X-ObSync-Gene`) matches the current one: then nothing changed and it
   * answers 204. The zip response carries the current gene in the same header.
   */
  initSync = async (req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const clientGene = req.headers["x-obsync-gene"];
    const queue = this.#queueManager.getOrCreateQueue(clientId);

    try {
      await queue.addTask(async () => {
        // Read before zipping: a change landing in between leaves the client with a gene
        // older than its files, which only costs one extra download next time
        const currentGene = await this.#readVaultGene();
        if (currentGene && clientGene === currentGene) {
          res.sendStatus(204);
          return;
        }
        if (currentGene) {
          res.setHeader("X-ObSync-Gene", currentGene);
        }

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
      if (res.headersSent) {
        console.error("[Zip] Vault transfer failed during the sending", error);
        res.destroy();
        return;
      }
      console.error("[Zip] Error sending the file", error);
      res.status(500).json({ error: "[Zip] Internal error generating the file." });
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
        //spread vault changes to the WebSocket
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
    }
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const { path, isFolder } = req.body;

    if (typeof path !== "string" || !path.trim()) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const queue = this.#queueManager.getOrCreateQueue(clientId);
    try {
      await queue.addTask(async () => {
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
    }
  };

  modify = async (req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const { path, content } = req.body;

    if (typeof path !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "Invalid content or path" });
      return;
    }

    const queue = this.#queueManager.getOrCreateQueue(clientId);
    try {
      await queue.addTask(async () => {
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
      }, `file:${path}:modify`);
    } catch (error) {
      console.error("[Sync] Error in Modify:", error);
      res.status(500).json({ error: "Error modifying file" });
    }
  };

  rename = async (req: Request, res: Response): Promise<void> => {
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
    try {
      // Keyed on the source path: it is the resource that stops existing, and
      // locking both paths at once would open the door to a deadlock.
      await queue.addTask(async () => {
        await this.#collaborationServer.renamePersistedStatePath(
          oldPath,
          newPath,
        );
        const moved = await this.#fileManager.rename(oldPath, newPath);
        // Already applied in the canonical vault, so there is nothing to spread
        if (!moved) {
          res.sendStatus(200);
          return;
        }
        publishVaultChange({
          type: "rename",
          oldPath,
          newPath,
          originClientId: clientId,
        });
        res.sendStatus(200);
      }, `file:${newPath}:rename`);
    } catch (error) {
      console.error("[Sync] Error in Rename:", error);
      res.status(500).json({ error: "Error renaming" });
    }
  };

  /** Expects the raw body already parsed by `express.raw` in the route. */
  createFile = async (req: Request, res: Response): Promise<void> => {
    const clientId = res.locals.clientId as string;
    const { ["x-obsync-filepath"]: path } = req.headers;

    if (typeof path !== "string") {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      console.error("[Sync] The file is empty or is missing an important field");
      res.status(400).json({ error: "Error making file" });
      return;
    }

    const nodeBuffer = req.body as Buffer<ArrayBuffer>;
    const queue = this.#queueManager.getOrCreateQueue(clientId);
    try {
      await queue.addTask(async () => {
        await this.#fileManager.createOrModifyFile(path, nodeBuffer);
        publishVaultChange({
          type: "create",
          path,
          isFolder: false,
          isBinary: true,
        });
        res.sendStatus(200);
      }, `file:${path}:writeBinary`);
    } catch (error) {
      console.error("[Sync] Error in Sending File", error);
      res.status(500).json({ error: "Error making file" });
    }
  };

  getFile = async (req: Request, res: Response): Promise<void> => {
    const { path, fileName } = req.query;
    const clientId = res.locals.clientId as string;
    const fileNameOrDirectory = path === fileName ? fileName : path;
    const relativo = pathes.join(systemPaths.vault, String(fileNameOrDirectory));
    const queue = this.#queueManager.getOrCreateQueue(clientId);

    try {
      await queue.addTask(async () => {
        await this.#downloadVault(relativo, clientId, res);
      }, `file:${clientId}:send`);
    } catch (error) {
      if (res.headersSent) {
        console.error("[Sync] File transfer failed during the sending");
        res.destroy();
        return;
      }
      console.error("[Sync] Error while sending the File", error);
      res.status(500).json({ error: "Error while sending the File" });
    }
  };
}
