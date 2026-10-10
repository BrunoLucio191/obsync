import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import type { YjsCollaborationServer } from "../yjs/YjsCollaborationServer.ts";

const BINARY_STATE_EXTENSION = ".yjs-state";
const BINARY_HYDRATION_ORIGIN = Symbol("binary-state-hydration");
const MARKDOWN_HYDRATION_ORIGIN = Symbol("markdown-bootstrap");

type DocumentWriteState = {
  readonly filePath: string;
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

/**
 * Saves each document twice: the binary Yjs state (the authority) and a markdown
 * mirror in the vault, so the files stay readable outside the app.
 */
export class YjsPersistence {
  readonly #vaultRoot: string;
  readonly #stateRoot: string;
  readonly #collaborationServer: YjsCollaborationServer;
  readonly #documentStates = new WeakMap<Y.Doc, DocumentWriteState>();
  readonly #pendingWriting = new Set();
  public constructor(
    vaultPath: string,
    statePath: string,
    collaborationServer: YjsCollaborationServer,
  ) {
    this.#vaultRoot = path.resolve(vaultPath);
    this.#stateRoot = path.resolve(statePath);
    this.#collaborationServer = collaborationServer;
  }

  /** Decode the file name, reads the binary state , apply the binary update and
   * bind the Y.doc to the state inside a map
   * @param ydoc - the ydoc document that is shared between users
   * @param docPath - docName is the path
   */
  public async bindState(docPath: string, ydoc: Y.Doc): Promise<void> {
    const filePath = this.#decodeDocumentPath(docPath);
    const binaryState = await this.#readBinaryState(filePath);

    if (binaryState) {
      Y.applyUpdate(ydoc, binaryState, BINARY_HYDRATION_ORIGIN);
    } else {
      await this.#bootstrapFromMarkdown(filePath, ydoc);
    }

    const previous = this.#documentStates.get(ydoc);
    if (previous) ydoc.off("update", previous.onUpdate);

    const state: DocumentWriteState = {
      filePath,
      ydoc,
      dirty: false,
      writing: null,
      revision: 0,
      onUpdate: () => undefined,
    };

    state.onUpdate = () => {
      state.revision += 1;
      state.dirty = true;

      void this.#flush(state).catch((error: unknown) => {
        console.error(`[Yjs] Failed to persist ${state.filePath}:`, error);
      });
    };

    this.#documentStates.set(ydoc, state);
    ydoc.on("update", state.onUpdate);

    if (!binaryState) {
      state.dirty = true;
      await this.#flush(state);
    }
  }

  public async writeState(docPath: string, ydoc: Y.Doc): Promise<void> {
    const state = this.#getOrCreateState(docPath, ydoc);
    state.dirty = true;

    await this.#flush(state);
  }

  public async destroyState(_docName: string, ydoc: Y.Doc): Promise<void> {
    const state = this.#documentStates.get(ydoc);
    if (!state) return;

    if (state.writing) await state.writing;
    ydoc.off("update", state.onUpdate);
    this.#documentStates.delete(ydoc);
  }

  /** Delete a files or whole folder and the directories inside of it
   * @param targetPath
   */
  public async deleteStateUnderPath(targetPath: string): Promise<void> {
    const normalized = this.#normalizeRelativePath(targetPath);
    const fileStatePath = this.#resolveStateFilePath(normalized);
    const folderStatePath = this.#resolveStateDirectoryPath(normalized);

    await Promise.all([...this.#pendingWriting])
      .catch((error: unknown) =>
        console.error("[Yjs] a file writing Failed", error),
      )
      .then(async () => {
        await Promise.all([
          fsPromises.rm(fileStatePath, { force: true }),
          fsPromises.rm(folderStatePath, { recursive: true, force: true }),
        ]);
      });
  }

  /** Keeps the collaboration history across a vault rename. */
  public async renameStatePath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const normalizedOld = this.#normalizeRelativePath(oldPath);
    const normalizedNew = this.#normalizeRelativePath(newPath);

    const oldFile = this.#resolveStateFilePath(normalizedOld);
    const newFile = this.#resolveStateFilePath(normalizedNew);
    const oldDirectory = this.#resolveStateDirectoryPath(normalizedOld);
    const newDirectory = this.#resolveStateDirectoryPath(normalizedNew);

    await Promise.all([...this.#pendingWriting])
      .catch((error: unknown) =>
        console.error("[Yjs] a file writing Failed", error),
      )
      .then(async () => {
        if (await this.#pathExists(oldDirectory)) {
          await fsPromises.mkdir(path.dirname(newDirectory), {
            recursive: true,
          });
          await fsPromises.rename(oldDirectory, newDirectory);
        }
        if (await this.#pathExists(oldFile)) {
          await fsPromises.mkdir(path.dirname(newFile), { recursive: true });
          await fsPromises.rename(oldFile, newFile);
        }
      });
  }
  /** If the binary state doesn't exist, the ydoc loads the content from the note
   * @param filePath
   * @param ydoc
   */
  async #bootstrapFromMarkdown(filePath: string, ydoc: Y.Doc): Promise<void> {
    const fullPath = this.#resolveVaultPath(filePath);

    try {
      const content = await fsPromises.readFile(fullPath, "utf8");
      const ytext = ydoc.getText("codemirror");

      if (ytext.length === 0 && content.length > 0) {
        ydoc.transact(() => {
          ytext.insert(0, content);
        }, MARKDOWN_HYDRATION_ORIGIN);
      }
    } catch (error) {
      if (!this.#isMissingFileError(error)) throw error;
    }
  }
  /** Reads the file state from a given path, transform that buffer into a Uint8Array
   * @param filePath
   */
  async #readBinaryState(filePath: string): Promise<Uint8Array | null> {
    const statePath = this.#resolveStateFilePath(filePath);

    try {
      const buffer = await fsPromises.readFile(statePath);
      if (buffer.byteLength === 0) {
        throw new Error(`Empty or corrupted Yjs state: ${statePath}`);
      }

      //turns the buffer into the Uint8Array with the exact same view
      const state = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );

      return state;
    } catch (error) {
      if (this.#isMissingFileError(error)) return null;
      throw error;
    }
  }

  #getOrCreateState(docPath: string, ydoc: Y.Doc): DocumentWriteState {
    const existing = this.#documentStates.get(ydoc);
    if (existing) return existing;

    const state: DocumentWriteState = {
      filePath: this.#decodeDocumentPath(docPath),
      ydoc,
      dirty: false,
      writing: null,
      revision: 0,
      onUpdate: () => undefined,
    };

    this.#documentStates.set(ydoc, state);
    return state;
  }

  /** Concurrent calls share the in-flight write, so a document never has two writes at once. */
  #flush(state: DocumentWriteState): Promise<void> {
    if (state.writing) return state.writing;

    const writing = this.#flushLoop(state).finally(() => {
      state.writing = null;
      this.#pendingWriting.delete(writing);
    });
    this.#pendingWriting.add(writing);
    state.writing = writing;

    return state.writing;
  }

  /** Loops until no update arrived during the write, so a burst during a slow write isn't lost. */
  async #flushLoop(state: DocumentWriteState): Promise<void> {
    while (state.dirty) {
      state.dirty = false;

      if (
        this.#collaborationServer.isDocumentInvalidated(state.ydoc) ||
        this.#collaborationServer.isPathDeleted(state.filePath)
      ) {
        return;
      }

      const snapshot: DocumentSnapshot = {
        markdown: state.ydoc.getText("codemirror").toString(),
        binaryState: Y.encodeStateAsUpdate(state.ydoc),
      };

      try {
        await this.#writeBinaryState(state.filePath, snapshot.binaryState);
        await this.#writeMarkdown(state.filePath, snapshot.markdown);
      } catch (error) {
        state.dirty = true;
        throw error;
      }
    }
  }

  async #writeBinaryState(
    fileName: string,
    binaryState: Uint8Array,
  ): Promise<void> {
    await this.#atomicWrite(this.#resolveStateFilePath(fileName), binaryState);
  }

  async #writeMarkdown(fileName: string, content: string): Promise<void> {
    await this.#atomicWrite(this.#resolveVaultPath(fileName), content);
  }
  /** Receive data and make a tmp directory, write the file inside
   * of it and then moves the file to the destination
   * @param destination - The path that is the destination of data being written
   * inside the tmp file.
   * @param data - The data that will be written
   */
  async #atomicWrite(
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
        .catch((): undefined => undefined);
    }
  }

  #resolveVaultPath(relativePath: string): string {
    return this.#resolveInsideRoot(this.#vaultRoot, relativePath);
  }

  #resolveStateFilePath(relativePath: string): string {
    return this.#resolveInsideRoot(
      this.#stateRoot,
      `${relativePath}${BINARY_STATE_EXTENSION}`,
    );
  }

  #resolveStateDirectoryPath(relativePath: string): string {
    return this.#resolveInsideRoot(this.#stateRoot, relativePath);
  }
  /** Resolves the relative for a state, receives a root path an than join the root with
   * the relative path since this class deals with the vaultRoot and stateRoot
   * @param root - can be either the vaultRoot or stateRoot
   * @param relativePath - the file path
   */
  #resolveInsideRoot(root: string, relativePath: string): string {
    const normalized = this.#normalizeRelativePath(relativePath);
    const fullPath = path.resolve(root, normalized);

    if (!fullPath.startsWith(`${root}/`)) {
      throw new Error("The Yjs document must be inside the allowed directory.");
    }

    return fullPath;
  }
  /** Normalize the relative path replacing // with /
   * and settings paths with ./ or ../ invalids
   * @param relativePath - relative path
   */
  #normalizeRelativePath(relativePath: string): string {
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

  /**Decodes the document Path that is a URI and calls the normalization for that path*/
  #decodeDocumentPath(docPath: string): string {
    try {
      return this.#normalizeRelativePath(decodeURIComponent(docPath));
    } catch {
      throw new Error(`Invalid Yjs document name: ${docPath}`);
    }
  }

  /** Verify if the path exists or not
   * @param filePath
   */
  async #pathExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (this.#isMissingFileError(error)) return false;
      throw error;
    }
  }
  /** checks if the error is the ENOENT from node, missing file
   * @param error
   */
  #isMissingFileError(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
