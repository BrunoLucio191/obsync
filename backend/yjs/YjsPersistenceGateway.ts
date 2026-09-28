import type * as Y from "yjs";
import type { YjsPersistenceAdapter } from "./yjs.types.ts";

/** Every call is a no-op until `setAdapter`, so callers never check for an adapter. */
export class YjsPersistenceGateway {
  #adapter: YjsPersistenceAdapter | undefined;

  public setAdapter(adapter: YjsPersistenceAdapter): void {
    this.#adapter = adapter;
  }

  public async bindState(docName: string, doc: Y.Doc): Promise<void> {
    await this.#adapter?.bindState(docName, doc);
  }

  public async writeState(docName: string, doc: Y.Doc): Promise<void> {
    await this.#adapter?.writeState(docName, doc);
  }

  public async destroyState(docName: string, doc: Y.Doc): Promise<void> {
    await this.#adapter?.destroyState?.(docName, doc);
  }

  public async deleteStateUnderPath(targetPath: string): Promise<void> {
    await this.#adapter?.deleteStateUnderPath?.(targetPath);
  }

  public async renameStatePath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    await this.#adapter?.renameStatePath?.(oldPath, newPath);
  }
}
