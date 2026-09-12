import { readFile, writeFile, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import fs from "fs";
import { timingSafeEqual } from "node:crypto";

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

/** The gene file is responsible for tracking the changes inside the vault.
 *  UpdateGene controls the whole flux when it comes to deal with the gene file
 *
 *  `generation` - How many times the vault has changes.
 *  `bytes` - How many bytes the vault has.
 *  `fileCount` - The number of files inside the vault.
 *  `lastModification` - the date and hour from the last modification in ISO forma and
 *
 *  @params directory - A valid directory
 *  @params genePath - Path for the gene file
 */
export class Gene {
  #directory!: string;
  #genePath!: string;
  constructor(vaultDirectory: string, genePath: string) {
    this.#checkPathsValid(vaultDirectory, genePath);
    this.#genePath = genePath;
    this.#directory = vaultDirectory;
  }
  #checkPathsValid(vaultDirectory: string, genePath: string) {
    switch (true) {
      case !fs.existsSync(vaultDirectory):
        console.error("This directory is not valid");
        return;
      case !fs.existsSync(genePath):
        console.error("Ths gene path is not valid");
        return;
      case typeof vaultDirectory != "string" || !vaultDirectory.trim():
        console.error("This directory is not valid");
        return;
      case typeof genePath != "string" || !genePath.trim():
        console.error("This directory is not valid");
        return;
    }
  }
  /** Makes a new empty gene File*/
  public async makeNewGene(
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
  async #verifyGeneKeys(directory: string = this.#directory): Promise<boolean> {
    if (!fs.existsSync(directory)) {
      console.error("This directory is not valid");
      return false;
    }
    const geneCandidateFile = await readFile(directory, { encoding: "utf8" });
    const geneCandidateKeys = Object.keys(JSON.parse(geneCandidateFile));
    const defaultGeneKeys = Object.keys(geneMissing);

    if (JSON.stringify(geneCandidateKeys) == JSON.stringify(defaultGeneKeys)) {
      return true;
    } else {
      console.error("this isn't a valid gene file, a new one will be made");
      this.makeNewGene(directory);
      return false;
    }
  }
  /** compare if two gene JSON are iqual */
  public compareGenes(gen1: VaultGene, gen2: VaultGene): boolean {
    const gene1 = Buffer.from(JSON.stringify(gen1));
    const gene2 = Buffer.from(JSON.stringify(gen2));
    return timingSafeEqual(gene1, gene2);
  }
  /** returns the current data and hour in ISO */
  #lastUpdate() {
    return new Date().toISOString();
  }
  /** returns the number of files and the byteSize from the whole vault */
  async getBytesAndNumOfFiles(directory: string = this.#directory) {
    const files = await readdir(directory, { recursive: true });

    const stats = files.map(async (file) => {
      let isDirectory = await stat(path.join(directory, file));
      if (!isDirectory.isDirectory()) {
        return isDirectory.size;
      }
    });
    const sizeOfFiles = await Promise.all(stats);

    //doesn't count empty files neither folders
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
   *  @params directory - A valid directory
   *  @params genePath - Path for the gene file
   */
  async mutateVaultGene(directory = this.#directory, genePath = this.#genePath): Promise<void> {
    this.#checkPathsValid(directory, genePath);
    console.log("[Gene] The vault is watching the gene file");

    watch(directory, { recursive: true }, async () => {
      let vaultGene = undefined;
      try {
        vaultGene = await readFile(genePath, { encoding: "utf8" });
        if (await this.#verifyGeneKeys(vaultGene)) {
          console.log("This gene file is not valid, a new one will be made");
          await this.makeNewGene();
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
        this.makeNewGene();
      }

      const { filesCount, bytes } = await this.getBytesAndNumOfFiles(directory);
      vaultGeneObj.generation++;
      vaultGeneObj.bytes = bytes;
      vaultGeneObj.lastModification = this.#lastUpdate();
      vaultGeneObj.filesCount = filesCount;
      const vaultGeneModifications = Buffer.from(JSON.stringify(vaultGeneObj));
      await writeFile(genePath, vaultGeneModifications);
    });
  }
}
