import fsPromises from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { systemPaths } from "../paths.ts";

/**
 * Performs filesystem operations (create, modify, delete, rename, zip) scoped to the vault
 * directory. Every path-accepting method resolves and validates the path against the vault
 * root first, so callers cannot escape the vault via absolute paths or `..` segments.
 */
export class FileManager {
  private vaultPath!: string;
  private vaultExitPath!: string;

  constructor() {
    this.vaultPath = systemPaths.vault;
    this.vaultExitPath = systemPaths.vaultExit;
  }

  /**
   * Resolves a vault-relative path to an absolute filesystem path, rejecting anything that
   * would escape the vault root.
   * @param relativePath - Path relative to the vault root.
   * @returns The absolute, resolved path inside the vault.
   * @throws If `relativePath` is empty, absolute, or resolves outside the vault root.
   */
  private resolveVaultPath(relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("The file path is required.");
    }

    if (path.isAbsolute(relativePath)) {
      throw new Error("Absolute paths are not allowed.");
    }
    const vaultRoot = path.resolve(this.vaultPath);

    const fullPath = path.resolve(vaultRoot, relativePath);

    if (!fullPath.startsWith(`${vaultRoot}${path.sep}`)) {
      throw new Error("The path must be inside the vault.");
    }

    return fullPath;
  }

  /**
   * Convenience wrapper around {@link createOrModifyFile} with the arguments swapped (content first).
   * @param fileContent - Text content to write.
   * @param name - Vault-relative path to write to.
   */
  public async stringToFile(fileContent: string, name: string): Promise<void> {
    await this.createOrModifyFile(name, fileContent);
  }

  /**
   * Writes a file's content, creating parent directories as needed. Creates the file if it
   * doesn't exist, or overwrites it if it does.
   * @param filePath - Vault-relative path of the file to write.
   * @param content - Text content to write.
   */
  public async createOrModifyFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    const fullPath = this.resolveVaultPath(filePath);
    const dirName = path.dirname(fullPath);

    await fsPromises.mkdir(dirName, { recursive: true });
    await fsPromises.writeFile(fullPath, content);
  }

  /**
   * Creates a directory (and any missing parents) inside the vault.
   * @param folderPath - Vault-relative path of the folder to create.
   */
  public async createFolder(folderPath: string): Promise<void> {
    const fullPath = this.resolveVaultPath(folderPath);
    await fsPromises.mkdir(fullPath, { recursive: true });
  }

  /**
   * Deletes a file or directory (recursively) inside the vault. No-op if the path doesn't exist.
   * @param targetPath - Vault-relative path to delete.
   */
  public async deletePath(targetPath: string): Promise<void> {
    const fullPath = this.resolveVaultPath(targetPath);
    await fsPromises.rm(fullPath, { recursive: true, force: true });
  }

  /**
   * Moves/renames a file or directory within the vault, creating the destination's parent directory as needed.
   * @param oldPath - Current vault-relative path.
   * @param newPath - Destination vault-relative path.
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOld = this.resolveVaultPath(oldPath);
    const fullNew = this.resolveVaultPath(newPath);
    const newDirName = path.dirname(fullNew);

    await fsPromises.mkdir(newDirName, { recursive: true });
    await fsPromises.rename(fullOld, fullNew);
  }

  /**
   * Compresses the entire vault (excluding dotfiles/dot-directories) into a single zip archive
   * at the configured vault-exit path, ready for download.
   * @returns Resolves once the archive has been fully written to disk.
   * @throws If the archiver reports an error while building the zip.
   */
  public async directoryZiped(): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(this.vaultExitPath);
      const archive = new ZipArchive({
        zlib: { level: 9 },
      });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);

      archive.glob("**/*", {
        cwd: this.vaultPath,
        ignore: ["**/.*", "**/.*/**"],
      });

      archive.finalize();
    });
  }
}
