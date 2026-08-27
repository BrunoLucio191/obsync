import type * as Y from "yjs";
import type { YjsPersistenceAdapter } from "./yjs.types.ts";

/**
 * Thin indirection layer in front of a {@link YjsPersistenceAdapter}, so the rest of the
 * collaboration server can call persistence operations unconditionally even before (or without)
 * an adapter being configured — every call becomes a safe no-op until `setAdapter` is called.
 */
export class YjsPersistenceGateway {
  /** The currently configured persistence backend, if any. */
  private adapter: YjsPersistenceAdapter | undefined;

  /**
   * Installs the persistence backend used by all subsequent calls.
   * @param adapter - Concrete storage implementation to delegate to.
   */
  public setAdapter(adapter: YjsPersistenceAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Loads/hydrates a document's persisted state, if an adapter is configured.
   * @param docName - Encoded document identifier used as the storage key.
   * @param doc - In-memory Yjs document to hydrate.
   */
  public async bindState(docName: string, doc: Y.Doc): Promise<void> {
    await this.adapter?.bindState(docName, doc);
  }

  /**
   * Persists a document's current state, if an adapter is configured.
   * @param docName - Encoded document identifier used as the storage key.
   * @param doc - In-memory Yjs document whose state should be saved.
   */
  public async writeState(docName: string, doc: Y.Doc): Promise<void> {
    await this.adapter?.writeState(docName, doc);
  }

  /**
   * Releases adapter-held resources for a document, if an adapter is configured and supports it.
   * @param docName - Encoded document identifier used as the storage key.
   * @param doc - In-memory Yjs document being discarded.
   */
  public async destroyState(docName: string, doc: Y.Doc): Promise<void> {
    await this.adapter?.destroyState?.(docName, doc);
  }

  /**
   * Deletes persisted state under a vault path, if an adapter is configured and supports it.
   * @param targetPath - Normalized vault path that was deleted.
   */
  public async deleteStateUnderPath(targetPath: string): Promise<void> {
    await this.adapter?.deleteStateUnderPath?.(targetPath);
  }

  /**
   * Moves persisted state from one vault path to another, if an adapter is configured and supports it.
   * @param oldPath - Normalized vault path being moved from.
   * @param newPath - Normalized vault path being moved to.
   */
  public async renameStatePath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    await this.adapter?.renameStatePath?.(oldPath, newPath);
  }
}
