import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import { isDocumentInvalidated, isPathDeleted } from "../yjsUtils.ts";

const BINARY_STATE_EXTENSION = ".yjs-state";
const BINARY_HYDRATION_ORIGIN = Symbol("binary-state-hydration");
const MARKDOWN_HYDRATION_ORIGIN = Symbol("markdown-bootstrap");

type DocumentWriteState = {
  readonly fileName: string;
  readonly ydoc: Y.Doc;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
  dirty: boolean;
  writing: Promise<void> | null;
  revision: number;
};

type DocumentSnapshot = {
  readonly markdown: string;
  readonly binaryState: Uint8Array;
};

export class YjsPersistence {
  private readonly vaultRoot: string;
  private readonly stateRoot: string;
  private readonly documentStates = new WeakMap<Y.Doc, DocumentWriteState>();

  public constructor(vaultPath: string, statePath?: string) {
    this.vaultRoot = path.resolve(vaultPath);
    this.stateRoot = path.resolve(
      statePath ??
        path.join(
          path.dirname(this.vaultRoot),
          ".obisync-yjs-state",
          path.basename(this.vaultRoot),
        ),
    );
  }

  public async bindState(docName: string, ydoc: Y.Doc): Promise<void> {
    const fileName = this.decodeDocumentName(docName);
    const binaryState = await this.readBinaryState(fileName);

    if (binaryState) {
      Y.applyUpdate(ydoc, binaryState, BINARY_HYDRATION_ORIGIN);
    } else {
      await this.bootstrapFromMarkdown(fileName, ydoc);
    }

    const previous = this.documentStates.get(ydoc);
    if (previous) ydoc.off("update", previous.onUpdate);

    const state: DocumentWriteState = {
      fileName,
      ydoc,
      dirty: false,
      writing: null,
      revision: 0,
      onUpdate: () => undefined,
    };

    state.onUpdate = (update: Uint8Array, origin: unknown) => {
      state.revision += 1;
      state.dirty = true;

      void this.flush(state).catch((error: unknown) => {
        console.error(`[Yjs] Falha ao persistir ${state.fileName}:`, error);
      });
    };

    this.documentStates.set(ydoc, state);
    ydoc.on("update", state.onUpdate);

    if (!binaryState) {
      state.dirty = true;
      await this.flush(state);
    }
  }

  public async writeState(docName: string, ydoc: Y.Doc): Promise<void> {
    const state = this.getOrCreateState(docName, ydoc);
    state.dirty = true;

    await this.flush(state);
  }

  public async destroyState(_docName: string, ydoc: Y.Doc): Promise<void> {
    const state = this.documentStates.get(ydoc);
    if (!state) return;

    if (state.writing) await state.writing;
    ydoc.off("update", state.onUpdate);
    this.documentStates.delete(ydoc);
  }

  public async deleteStateUnderPath(targetPath: string): Promise<void> {
    const normalized = this.normalizeRelativePath(targetPath);
    const fileStatePath = this.resolveStateFilePath(normalized);
    const folderStatePath = this.resolveStateDirectoryPath(normalized);

    await Promise.all([
      fsPromises.rm(fileStatePath, { force: true }),
      fsPromises.rm(folderStatePath, { recursive: true, force: true }),
    ]);
  }

  public async renameStatePath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const normalizedOld = this.normalizeRelativePath(oldPath);
    const normalizedNew = this.normalizeRelativePath(newPath);

    const oldFile = this.resolveStateFilePath(normalizedOld);
    const newFile = this.resolveStateFilePath(normalizedNew);
    const oldDirectory = this.resolveStateDirectoryPath(normalizedOld);
    const newDirectory = this.resolveStateDirectoryPath(normalizedNew);

    if (await this.pathExists(oldDirectory)) {
      await fsPromises.mkdir(path.dirname(newDirectory), { recursive: true });
      await fsPromises.rename(oldDirectory, newDirectory);
    }

    if (await this.pathExists(oldFile)) {
      await fsPromises.mkdir(path.dirname(newFile), { recursive: true });
      await fsPromises.rename(oldFile, newFile);
    }
  }

  private async bootstrapFromMarkdown(
    fileName: string,
    ydoc: Y.Doc,
  ): Promise<void> {
    const fullPath = this.resolveVaultPath(fileName);

    try {
      const content = await fsPromises.readFile(fullPath, "utf8");
      const ytext = ydoc.getText("codemirror");

      if (ytext.length === 0 && content.length > 0) {
        ydoc.transact(() => {
          ytext.insert(0, content);
        }, MARKDOWN_HYDRATION_ORIGIN);
      }
    } catch (error) {
      if (!this.isMissingFileError(error)) throw error;
    }
  }

  private async readBinaryState(fileName: string): Promise<Uint8Array | null> {
    const statePath = this.resolveStateFilePath(fileName);

    try {
      const buffer = await fsPromises.readFile(statePath);
      if (buffer.byteLength === 0) {
        throw new Error(`Estado Yjs vazio ou corrompido: ${statePath}`);
      }

      const state = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );

      return state;
    } catch (error) {
      if (this.isMissingFileError(error)) return null;
      throw error;
    }
  }

  private getOrCreateState(docName: string, ydoc: Y.Doc): DocumentWriteState {
    const existing = this.documentStates.get(ydoc);
    if (existing) return existing;

    const state: DocumentWriteState = {
      fileName: this.decodeDocumentName(docName),
      ydoc,
      dirty: false,
      writing: null,
      revision: 0,
      onUpdate: () => undefined,
    };

    this.documentStates.set(ydoc, state);
    return state;
  }

  private flush(state: DocumentWriteState): Promise<void> {
    if (state.writing) return state.writing;

    state.writing = this.flushLoop(state).finally(() => {
      state.writing = null;
    });

    return state.writing;
  }

  private async flushLoop(state: DocumentWriteState): Promise<void> {
    while (state.dirty) {
      state.dirty = false;

      if (isDocumentInvalidated(state.ydoc) || isPathDeleted(state.fileName)) {
        return;
      }

      const snapshot: DocumentSnapshot = {
        markdown: state.ydoc.getText("codemirror").toString(),
        binaryState: Y.encodeStateAsUpdate(state.ydoc),
      };

      try {
        await this.writeBinaryState(state.fileName, snapshot.binaryState);
        await this.writeMarkdown(state.fileName, snapshot.markdown);
      } catch (error) {
        state.dirty = true;
        throw error;
      }
    }
  }

  private async writeBinaryState(
    fileName: string,
    binaryState: Uint8Array,
  ): Promise<void> {
    await this.atomicWrite(this.resolveStateFilePath(fileName), binaryState);
  }

  private async writeMarkdown(
    fileName: string,
    content: string,
  ): Promise<void> {
    await this.atomicWrite(this.resolveVaultPath(fileName), content);
  }

  private async atomicWrite(
    destination: string,
    data: string | Uint8Array,
  ): Promise<void> {
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });

    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fsPromises.writeFile(temporaryPath, data);
      await fsPromises.rename(temporaryPath, destination);
    } finally {
      await fsPromises
        .rm(temporaryPath, { force: true })
        .catch(() => undefined);
    }
  }

  private resolveVaultPath(relativePath: string): string {
    return this.resolveInsideRoot(this.vaultRoot, relativePath);
  }

  private resolveStateFilePath(relativePath: string): string {
    return this.resolveInsideRoot(
      this.stateRoot,
      `${relativePath}${BINARY_STATE_EXTENSION}`,
    );
  }

  private resolveStateDirectoryPath(relativePath: string): string {
    return this.resolveInsideRoot(this.stateRoot, relativePath);
  }

  private resolveInsideRoot(root: string, relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    const fullPath = path.resolve(root, normalized);

    if (!fullPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        "O documento Yjs precisa estar dentro do diretório permitido.",
      );
    }

    return fullPath;
  }

  private normalizeRelativePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/").trim();

    if (!normalized || path.isAbsolute(normalized)) {
      throw new Error("Caminho de documento Yjs inválido.");
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error("Caminho de documento Yjs inválido.");
    }

    return normalized;
  }

  private decodeDocumentName(docName: string): string {
    try {
      return this.normalizeRelativePath(decodeURIComponent(docName));
    } catch {
      throw new Error(`Nome de documento Yjs inválido: ${docName}`);
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (this.isMissingFileError(error)) return false;
      throw error;
    }
  }

  private isMissingFileError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
