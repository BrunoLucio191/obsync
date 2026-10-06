import type { QueueManager } from "../queue/QueueManager.ts";
import { readFile, writeFile, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import fs from "fs";

type VaultGene = {
  generation: number;
  bytes: number | undefined;
  filesCount: any;
  lastModification: string;
};

const geneMissing: VaultGene = {
  generation: 0,
  bytes: 0,
  filesCount: 0,
  lastModification: "",
};

const GENE_QUEUE_ID = "vault-gene";
const GENE_UPDATE_KEY = "vault:gene:update";
const GENE_READ_KEY = "vault:gene:read";

/** The gene file is responsible for tracking the changes inside the vault.
 *  UpdateGene controls the whole flux when it comes to deal with the gene file
 *
 *  - `generation` - How many times the vault has changes.
 *  - `bytes` - How many bytes the vault has.
 *  - `fileCount` - The number of files inside the vault.
 *  - `lastModification` - the date and hour from the last modification in ISO format
 *
 *  Reads and updates go through their own queue, so an update never reads the file while
 *  another one is writing it, and initSync never gets a half-written gene.
 */
export class Gene {
  #directory!: string;
  #genePath!: string;
  readonly #queueManager: QueueManager;
  /**
   *  @param vaultDirectory - A valid vault directory
   *  @param genePath - Path for the gene file
   *  @param queueManager - Queue manager built with the server's shared KeyedLock
   */
  constructor(
    vaultDirectory: string,
    genePath: string,
    queueManager: QueueManager,
  ) {
    this.#checkPathsValid(vaultDirectory, genePath);
    this.#genePath = genePath;
    this.#directory = vaultDirectory;
    this.#queueManager = queueManager;
  }

  /** Verify if the given path is a valid one
   * @param vaultDirectory
   * @param genePath
   */
  #checkPathsValid(vaultDirectory: string, genePath: string) {
    switch (true) {
      case !fs.existsSync(vaultDirectory):
        console.error("This directory is not valid o vault ta normal");
        return;
      case !fs.existsSync(genePath):
        console.error("Ths gene path is not valid gene path");
        return;
      case typeof vaultDirectory != "string" || !vaultDirectory.trim():
        console.error("This directory is not valid trim ta dando erro?");
        return;
      case typeof genePath != "string" || !genePath.trim():
        console.error("This directory is not valid gene hummm");
        return;
    }
  }

  /** Makes a new empty gene File
   * @param vaultDirectory
   * @param genePath
   */
  async #makeNewGene(
    vaultDirectory = this.#directory,
    genePath = this.#genePath,
  ): Promise<boolean> {
    this.#checkPathsValid(vaultDirectory, genePath);
    const geneMissing: VaultGene = {
      generation: 0,
      bytes: 0,
      filesCount: 0,
      lastModification: "",
    };
    const geneMissingWrite = Buffer.from(JSON.stringify(geneMissing));
    writeFile(genePath, geneMissingWrite);
    return true;
  }

  /** Verify if the gene file is valid and has all the fields, if not, a new empty one is made
   * @param genePath
   */
  async #verifyGeneKeys(genePath: string = this.#genePath): Promise<boolean> {
    if (!fs.existsSync(genePath)) {
      console.error("This directory is not valid gene keys");
      return false;
    }

    const geneCandidateFile = await readFile(genePath, { encoding: "utf8" });
    const geneCandidateKeys = Object.keys(JSON.parse(geneCandidateFile));
    const defaultGeneKeys = Object.keys(geneMissing);

    if (JSON.stringify(geneCandidateKeys) == JSON.stringify(defaultGeneKeys)) {
      return true;
    } else {
      console.error("this isn't a valid gene file, a new one will be made");
      this.#makeNewGene(genePath);
      return false;
    }
  }

  /** returns the current data and hour in ISO */
  #lastUpdate() {
    return new Date().toISOString();
  }

  /** returns the number of files and the byteSize from the whole vault,
   * doesn't count empty files neither empty folders.
   *
   *  @param vaultDirectory
   */
  async getBytesAndNumOfFiles(vaultDirectory: string = this.#directory) {
    const files = await readdir(vaultDirectory, { recursive: true });

    const stats = files.map(async (file) => {
      let isDirectory = await stat(path.join(vaultDirectory, file));
      if (!isDirectory.isDirectory()) {
        return isDirectory.size;
      }
    });
    const sizeOfFiles = await Promise.all(stats);

    const numberOfFilesNoFolders = sizeOfFiles.filter(
      (number) => number != undefined && number > 0,
    );
    const sumOfBytes = numberOfFilesNoFolders.reduce(
      (acumulator: number | undefined, currenteValue: number | undefined) => {
        if (acumulator != undefined && currenteValue != undefined) {
          return acumulator + currenteValue;
        }
      },
      0,
    );
    return {
      bytes: sumOfBytes,
      filesCount: numberOfFilesNoFolders.length,
    };
  }

  /** update the gene file in a specific directory
   *  @param directory - A valid directory
   *  @param genePath - Path for the gene file
   */
  async mutateVaultGene(
    directory = this.#directory,
    genePath = this.#genePath,
  ): Promise<void> {
    this.#checkPathsValid(directory, genePath);
    console.log("[Gene] The vault is watching the gene file");

    watch(directory, { recursive: true }, () => {
      void this.#queueUpdate(directory, genePath);
    });
  }

  /**
   * Queues a gene update. One waiting update is enough: it scans the vault as it is when it
   * runs, so the changes that arrive while it waits are counted by it too.
   * @param vaultDirectory
   * @param genePath
   *
   */
  async #queueUpdate(vaultDirectory: string, genePath: string): Promise<void> {
    const queue = this.#queueManager.getOrCreateQueue(GENE_QUEUE_ID);
    if (queue.getTaskIdentifiers.includes(GENE_UPDATE_KEY)) return;
    try {
      await queue.addTask(
        () => this.#updateGene(vaultDirectory, genePath),
        GENE_UPDATE_KEY,
      );
    } catch (error) {
      console.error("[Gene] Could not update the gene file", error);
    }
  }

  /** Read in the gene queue, so it's never caught mid-update. `null` if missing or invalid.
   * @param  genePath
   */
  public async readGene(genePath = this.#genePath): Promise<string | null> {
    const queue = this.#queueManager.getOrCreateQueue(GENE_QUEUE_ID);
    try {
      return await queue.addTask(async () => {
        return JSON.stringify(
          JSON.parse(await readFile(genePath, { encoding: "utf8" })),
        );
      }, GENE_READ_KEY);
    } catch {
      return null;
    }
  }

  /** Updates the gene file
   * @param vaultDirectory
   * @param genePath
   */
  async #updateGene(vaultDirectory: string, genePath: string): Promise<void> {
    let vaultGene = undefined;
    try {
      vaultGene = await readFile(genePath, { encoding: "utf8" });
      if (!(await this.#verifyGeneKeys(genePath))) {
        console.log("This gene file is not valid, a new one will be made");
        await this.#makeNewGene();
      }
    } catch (error) {
      console.error("there is no gene.json file, making one", error);
      const vaultGeneMissingBuffer = Buffer.from(JSON.stringify(geneMissing));
      await writeFile(genePath, vaultGeneMissingBuffer);
    }
    if (vaultGene == undefined) return;
    let vaultGeneObj = JSON.parse(vaultGene);

    if (vaultGeneObj == undefined || typeof vaultGeneObj != "object") {
      console.error("Error while reading the gene file, making a new one");
      this.#makeNewGene();
    }

    const { filesCount, bytes } =
      await this.getBytesAndNumOfFiles(vaultDirectory);
    vaultGeneObj.generation++;
    vaultGeneObj.bytes = bytes;
    vaultGeneObj.lastModification = this.#lastUpdate();
    vaultGeneObj.filesCount = filesCount;
    const vaultGeneModifications = Buffer.from(JSON.stringify(vaultGeneObj));
    await writeFile(genePath, vaultGeneModifications);
  }
}
