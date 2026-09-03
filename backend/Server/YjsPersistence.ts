import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import type { YjsCollaborationServer } from "../yjs/YjsCollaborationServer.ts";

const BINARY_STATE_EXTENSION = ".yjs-state";
const BINARY_HYDRATION_ORIGIN = Symbol("binary-state-hydration");
const MARKDOWN_HYDRATION_ORIGIN = Symbol("markdown-bootstrap");

/** Per-document bookkeeping used to debounce/serialize writes to disk as a Yjs document changes. */
type DocumentWriteState = {
  readonly fileName: string;
  readonly ydoc: Y.Doc;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
  dirty: boolean;
  writing: Promise<void> | null;
  revision: number;
};

/** A point-in-time view of a document's content in both representations that get persisted. */
type DocumentSnapshot = {
  readonly markdown: string;
  readonly binaryState: Uint8Array;
};

/**
 * Persists Yjs documents to disk in two forms kept in sync: a binary Yjs state file (the
 * authoritative CRDT state, under `stateRoot`) and a plain markdown mirror (under `vaultRoot`,
 * so files remain readable/editable outside the app). Also seeds new documents from existing
 * markdown files and keeps persisted state in sync with vault renames/deletes.
 */
export class YjsPersistence {
  private readonly vaultRoot: string;
  private readonly stateRoot: string;
  private readonly collaborationServer: YjsCollaborationServer;
  private readonly documentStates = new WeakMap<Y.Doc, DocumentWriteState>();

  /**
   * @param vaultPath - Root directory containing the markdown mirror of documents.
   * @param statePath - Root directory containing binary Yjs state files.
   * @param collaborationServer - Used to check whether a document/path has been invalidated or deleted before writing.
   */
  public constructor(
    vaultPath: string,
    statePath: string,
    collaborationServer: YjsCollaborationServer,
  ) {
    this.vaultRoot = path.resolve(vaultPath);
    this.stateRoot = path.resolve(statePath);
    this.collaborationServer = collaborationServer;
  }

  /**
   * Hydrates a Yjs document when a client first opens it: loads existing binary state if present,
   * otherwise bootstraps the document from its markdown file (if any), and starts listening for
   * further updates so they get persisted automatically.
   * @param docName - The (URI-encoded) document name, as provided by the Yjs provider.
   * @param ydoc - The in-memory Yjs document to hydrate and start tracking.
   */
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

    state.onUpdate = () => {
      state.revision += 1;
      state.dirty = true;

      void this.flush(state).catch((error: unknown) => {
        console.error(`[Yjs] Failed to persist ${state.fileName}:`, error);
      });
    };

    this.documentStates.set(ydoc, state);
    ydoc.on("update", state.onUpdate);

    if (!binaryState) {
      state.dirty = true;
      await this.flush(state);
    }
  }

  /**
   * Forces an immediate flush of a document's current state to disk, regardless of whether an
   * update event fired (e.g. used for explicit save points).
   * @param docName - The (URI-encoded) document name.
   * @param ydoc - The document to flush.
   */
  public async writeState(docName: string, ydoc: Y.Doc): Promise<void> {
    const state = this.getOrCreateState(docName, ydoc);
    state.dirty = true;

    await this.flush(state);
  }

  /**
   * Stops tracking a document (detaching its update listener) once it's no longer in memory,
   * waiting for any in-flight write to finish first so no data is lost.
   * @param _docName - Unused; kept to match the persistence provider interface.
   * @param ydoc - The document being torn down.
   */
  public async destroyState(_docName: string, ydoc: Y.Doc): Promise<void> {
    const state = this.documentStates.get(ydoc);
    if (!state) return;

    if (state.writing) await state.writing;
    ydoc.off("update", state.onUpdate);
    this.documentStates.delete(ydoc);
  }

  /**
   * Deletes any persisted binary state for a path and everything nested under it (for a file
   * or folder deletion), so stale state doesn't resurface if the path is reused.
   * @param targetPath - Vault-relative path (file or folder) whose persisted state should be removed.
   */
  public async deleteStateUnderPath(targetPath: string): Promise<void> {
    const normalized = this.normalizeRelativePath(targetPath);
    const fileStatePath = this.resolveStateFilePath(normalized);
    const folderStatePath = this.resolveStateDirectoryPath(normalized);

    await Promise.all([
      fsPromises.rm(fileStatePath, { force: true }),
      fsPromises.rm(folderStatePath, { recursive: true, force: true }),
    ]);
  }

  /**
   * Moves persisted binary state (file and/or folder) to match a vault rename, so collaboration
   * history survives the move.
   * @param oldPath - Previous vault-relative path.
   * @param newPath - New vault-relative path.
   */
  public async renameStatePath(oldPath: string, newPath: string): Promise<void> {
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

  /** Seeds a brand-new (empty) Yjs document from its existing markdown file, if one exists on disk. */
  private async bootstrapFromMarkdown(fileName: string, ydoc: Y.Doc): Promise<void> {
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

  /**
   * Reads a document's previously persisted binary Yjs state, if any.
   * @param fileName - Vault-relative document name.
   * @returns The binary state, or `null` if no state file exists.
   * @throws If the state file exists but is empty/corrupted, or on any other read error.
   */
  private async readBinaryState(fileName: string): Promise<Uint8Array | null> {
    const statePath = this.resolveStateFilePath(fileName);

    try {
      const buffer = await fsPromises.readFile(statePath);
      if (buffer.byteLength === 0) {
        throw new Error(`Empty or corrupted Yjs state: ${statePath}`);
      }

      const state = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

      return state;
    } catch (error) {
      if (this.isMissingFileError(error)) return null;
      throw error;
    }
  }

  /** Returns the existing write-tracking state for a document, or creates a fresh (not-yet-listening) one. */
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

  /**
   * Ensures a document's pending changes get written, coalescing concurrent calls onto the same
   * in-flight write so writes to a single document never run in parallel.
   * @param state - The document's write-tracking state.
   * @returns The (possibly shared) promise for the ongoing/triggered flush.
   */
  private flush(state: DocumentWriteState): Promise<void> {
    if (state.writing) return state.writing;

    state.writing = this.flushLoop(state).finally(() => {
      state.writing = null;
    });

    return state.writing;
  }

  /**
   * Repeatedly writes the document's current binary state and markdown mirror until no further
   * changes have accumulated (`dirty` stays `false`), so a burst of updates during a slow write
   * isn't lost. Skips writing entirely if the document/path has since been invalidated or deleted.
   */
  private async flushLoop(state: DocumentWriteState): Promise<void> {
    while (state.dirty) {
      state.dirty = false;

      if (
        this.collaborationServer.isDocumentInvalidated(state.ydoc) ||
        this.collaborationServer.isPathDeleted(state.fileName)
      ) {
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

  /** Writes a document's binary Yjs state to its state file. */
  private async writeBinaryState(fileName: string, binaryState: Uint8Array): Promise<void> {
    await this.atomicWrite(this.resolveStateFilePath(fileName), binaryState);
  }

  /** Writes a document's plain-text content to its markdown mirror file. */
  private async writeMarkdown(fileName: string, content: string): Promise<void> {
    await this.atomicWrite(this.resolveVaultPath(fileName), content);
  }

  /**
   * Writes data to a destination path atomically, via a temp file + rename, so a crash or
   * concurrent read never observes a partially written file.
   * @param destination - Final absolute path to write to.
   * @param data - Content to write.
   */
  private async atomicWrite(destination: string, data: string | Uint8Array): Promise<void> {
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });

    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fsPromises.writeFile(temporaryPath, data);
      await fsPromises.rename(temporaryPath, destination);
    } finally {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private resolveVaultPath(relativePath: string): string {
    return this.resolveInsideRoot(this.vaultRoot, relativePath);
  }

  /** Resolves a document's binary state file path (with the `.yjs-state` extension) inside `stateRoot`. */
  private resolveStateFilePath(relativePath: string): string {
    return this.resolveInsideRoot(this.stateRoot, `${relativePath}${BINARY_STATE_EXTENSION}`);
  }

  private resolveStateDirectoryPath(relativePath: string): string {
    return this.resolveInsideRoot(this.stateRoot, relativePath);
  }

  /**
   * Resolves a relative path against a root directory, ensuring the result stays inside that root.
   * @param root - Absolute root directory (either `vaultRoot` or `stateRoot`).
   * @param relativePath - Path relative to `root`.
   * @returns The absolute, resolved path.
   * @throws If the resolved path would fall outside `root`.
   */
  private resolveInsideRoot(root: string, relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    const fullPath = path.resolve(root, normalized);

    if (!fullPath.startsWith(`${root}${path.sep}`)) {
      throw new Error("The Yjs document must be inside the allowed directory.");
    }

    return fullPath;
  }

  /**
   * Normalizes and validates a relative path: converts backslashes to slashes, trims whitespace,
   * and rejects absolute paths or any `.`/`..` segment.
   * @param relativePath - The path to normalize.
   * @returns The normalized, forward-slash path.
   * @throws If the path is empty, absolute, or contains `.`/`..` segments.
   */
  private normalizeRelativePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/").trim();

    if (!normalized || path.isAbsolute(normalized)) {
      throw new Error("Invalid Yjs document path.");
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error("Invalid Yjs document path.");
    }

    return normalized;
  }

  /**
   * Decodes and normalizes a URI-encoded Yjs document name into a safe vault-relative path.
   * @param docName - The raw, URI-encoded document name from the Yjs provider.
   * @returns The decoded, normalized relative path.
   * @throws If the document name is not validly URI-encoded or normalizes to an invalid path.
   */
  private decodeDocumentName(docName: string): string {
    try {
      return this.normalizeRelativePath(decodeURIComponent(docName));
    } catch {
      throw new Error(`Invalid Yjs document name: ${docName}`);
    }
  }

  /** Checks whether a filesystem path exists, without throwing. */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (this.isMissingFileError(error)) return false;
      throw error;
    }
  }

  /** Type guard for a Node filesystem "file not found" (`ENOENT`) error. */
  private isMissingFileError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
