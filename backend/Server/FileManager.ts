import fsPromises from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { systemPaths } from "../paths.ts";
import fs from "fs";
import { zip } from "zip-a-folder";
/** Every path is validated first, so absolute paths or `..` can't escape the vault. */
export class FileManager {
  #vaultPath!: string;

  constructor() {
    this.#vaultPath = systemPaths.vault;
  }

  #resolveVaultPath(relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("The file path is required.");
    }

    if (path.isAbsolute(relativePath)) {
      throw new Error("Absolute paths are not allowed.");
    }
    const vaultRoot = path.resolve(this.#vaultPath);

    const fullPath = path.resolve(vaultRoot, relativePath);

    if (!fullPath.startsWith(`${vaultRoot}${path.sep}`)) {
      throw new Error("The path must be inside the vault.");
    }

    return fullPath;
  }

  public async stringToFile(fileContent: string, name: string): Promise<void> {
    await this.createOrModifyFile(name, fileContent);
  }

  public async createOrModifyFile(
    filePath: string,
    content: string | Buffer<ArrayBuffer>,
  ): Promise<void> {
    const fullPath = this.#resolveVaultPath(filePath);
    const dirName = path.dirname(fullPath);

    await fsPromises.mkdir(dirName, { recursive: true });
    await fsPromises.writeFile(fullPath, content);
  }

  /** `null` for folders, missing paths and paths outside the vault. */
  public async getFilePath(filePath: string): Promise<string | null> {
    try {
      const fullPath = this.#resolveVaultPath(filePath);
      return (await fsPromises.stat(fullPath)).isFile() ? fullPath : null;
    } catch {
      return null;
    }
  }

  public async isFolder(folderPath: string): Promise<boolean> {
    try {
      return (
        await fsPromises.stat(this.#resolveVaultPath(folderPath))
      ).isDirectory();
    } catch {
      return false;
    }
  }

  public async createFolder(folderPath: string): Promise<void> {
    const fullPath = this.#resolveVaultPath(folderPath);
    await fsPromises.mkdir(fullPath, { recursive: true });
  }

  public async deletePath(targetPath: string): Promise<void> {
    const fullPath = this.#resolveVaultPath(targetPath);
    await fsPromises.rm(fullPath, { recursive: true, force: true });
  }

  /**
   * Already applied when only the destination exists: Obsidian reports each descendant of a moved
   * folder after the folder itself. Not found means the source never reached the vault.
   */
  public async rename(
    oldPath: string,
    newPath: string,
  ): Promise<"moved" | "already-applied" | "not-found"> {
    const fullOld = this.#resolveVaultPath(oldPath);
    const fullNew = this.#resolveVaultPath(newPath);
    if (!fs.existsSync(fullOld)) {
      return fs.existsSync(fullNew) ? "already-applied" : "not-found";
    }
    const newDirName = path.dirname(fullNew);
    await fsPromises.mkdir(newDirName, { recursive: true });
    await fsPromises.rename(fullOld, fullNew);
    return "moved";
  }

  public async directoryZiped(
    zipPath: string,
    clientId: string,
  ): Promise<void> {
    if (!fs.existsSync(zipPath)) {
      console.error("This is not a valid path");
      return;
    }
    return new Promise((resolve, reject) => {
      const output = createWriteStream(`${zipPath}/${clientId.trim()}.zip`);
      const archive = new ZipArchive({
        zlib: { level: 9 },
      });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);

      archive.glob("**/*", {
        cwd: this.#vaultPath,
        ignore: ["**/.*", "**/.*/**"],
      });

      archive.finalize();
    });
  }
}
