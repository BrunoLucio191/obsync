import fsPromises from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { vaultPath, vaultExitPath } from "../paths.ts";
import type { UserRole } from "./authClass/authClass.ts";

export class FileManager {
  public vaultPath!: string;
  public vaultExitPath!: string;

  constructor() {
    this.vaultPath = vaultPath;
    this.vaultExitPath = vaultExitPath;
  }

  private resolveVaultPath(relativePath: string): string {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("O caminho do arquivo é obrigatório.");
    }

    if (path.isAbsolute(relativePath)) {
      throw new Error("Caminhos absolutos não são permitidos.");
    }

    const vaultRoot = path.resolve(this.vaultPath);
    const fullPath = path.resolve(vaultRoot, relativePath);
    if (!fullPath.startsWith(`${vaultRoot}${path.sep}`)) {
      throw new Error("O caminho precisa estar dentro do vault.");
    }

    return fullPath;
  }

  public async stringToFile(fileContent: string, name: string): Promise<void> {
    await this.createOrModifyFile(name, fileContent);
  }

  public async createOrModifyFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    const fullPath = this.resolveVaultPath(filePath);
    const dirName = path.dirname(fullPath);

    await fsPromises.mkdir(dirName, { recursive: true });
    await fsPromises.writeFile(fullPath, content);
  }

  public async createFolder(folderPath: string): Promise<void> {
    const fullPath = this.resolveVaultPath(folderPath);
    await fsPromises.mkdir(fullPath, { recursive: true });
  }

  public async deletePath(targetPath: string): Promise<void> {
    const fullPath = this.resolveVaultPath(targetPath);
    await fsPromises.rm(fullPath, { recursive: true, force: true });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOld = this.resolveVaultPath(oldPath);
    const fullNew = this.resolveVaultPath(newPath);
    const newDirName = path.dirname(fullNew);

    await fsPromises.mkdir(newDirName, { recursive: true });
    await fsPromises.rename(fullOld, fullNew);
  }

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
  public encode(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  public decode<T>(value: string): T {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  }

  public isUserRole(value: unknown): value is UserRole {
    return value === "admin" || value === "user";
  }

  public normalizeEmailKey(value: string): string {
    return value.normalize("NFKC").trim().toLowerCase();
  }

  public normalizeName(value: string): string {
    return value.normalize("NFKC").trim().replace(/\s+/g, " ");
  }

  public normalizeNameKey(value: string): string {
    return this.normalizeName(value).toLocaleLowerCase("pt-BR");
  }
}
