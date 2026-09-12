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
 *  `lastModification` - the date and hour from the last modification in ISO format
 */
export class Gene {
  private readonly directory!: string;
  constructor(directory: string) {
    if (!fs.existsSync(directory)) {
      console.error("This directory is not valid");
      return;
    }
    this.directory = directory;
  }
  public makeNewGene(directory: string = this.directory): boolean {
    if (!fs.existsSync(directory)) {
      console.error("This directory is not valid");
      return false;
    }
    const geneMissing: VaultGene = {
      generation: 0,
      bytes: 0,
      filesCount: 0,
      lastModification: "",
    };
    const geneMissingWrite = Buffer.from(JSON.stringify(geneMissing));
    writeFile(directory, geneMissingWrite);
    return true;
  }
  async #verifyGeneKeys(directory: string = this.directory) {
    const geneMissing: VaultGene = {
      generation: 0,
      bytes: 0,
      filesCount: 0,
      lastModification: "",
    };
    const vaultGeneMissingBuffer = Buffer.from(JSON.stringify(geneMissing));
    const defaultGeneKeys = Object.keys(geneMissing);
    const geneCandidate = await writeFile("gene.json", vaultGeneMissingBuffer);
    const geneCandidate = await readFile("gene.json", { encoding: "utf8" });
  }

  public compareGenes(gen1: VaultGene, gen2: VaultGene): boolean {
    const gene1 = Buffer.from(JSON.stringify(gen1));
    const gene2 = Buffer.from(JSON.stringify(gen2));
    return timingSafeEqual(gene1, gene2);
  }
  #lastUpdate() {
    return new Date().toISOString();
  }
  /** returns the number of files and the byteSize from the whole vault */
  async getBytesOrNumOfFiles(directory: string = this.directory) {
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
      NumOfFiles: numberOfFilesNoFolders.length,
    };
  }
  /** update the gene file in a specific directory
   *  @params directory - A valid directory
   */
  async mutateVaultGene(directory: string = this.directory): Promise<number | boolean | undefined> {
    if (typeof directory != "string" || directory == undefined) {
      console.error("This directory is not valid");
      return;
    } else if (!fs.existsSync(directory)) {
      console.error("This directory is not valid");
      return;
    }
    console.log("[Gene] The vault is watching the gene file");

    watch(directory, { recursive: true }, async () => {
      let vaultGene = undefined;
      try {
        vaultGene = await readFile("gene.json", { encoding: "utf8" });
      } catch (error) {
        console.error("there is no gene.json file, making one", error);
        const vaultGeneMissingBuffer = Buffer.from(JSON.stringify(geneMissing));
        await writeFile("gene.json", vaultGeneMissingBuffer);
      }
      if (vaultGene == undefined) return;
      let vaultGeneObj = JSON.parse(vaultGene);

      if (vaultGeneObj == undefined || typeof vaultGeneObj != "object") {
        console.error("Error while reading the gene file, making a new one");
      }

      vaultGeneObj.generation++;
      vaultGeneObj.bytes = (await this.getBytesOrNumOfFiles(directory)).bytes;
      vaultGeneObj.lastModification = this.#lastUpdate();
      vaultGeneObj.filesCount = (await this.getBytesOrNumOfFiles(directory)).NumOfFiles;

      const vaultGeneModifications = Buffer.from(JSON.stringify(vaultGeneObj));
      await writeFile("gene.json", vaultGeneModifications);
    });
    return;
  }
}
