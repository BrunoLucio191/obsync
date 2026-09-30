import type * as Y from "yjs";
import {
  isSamePathOrChild,
  normalizeVaultPath,
} from "./yjsUtils/vaultPath.utils.ts";

/** Lets new connections be refused and rooms be stopped even
 * while a room creation or flush is still running. */
export class DeletedPathRegistry {
  readonly #deletedRoots = new Set<string>();
  readonly #invalidatedDocuments = new WeakSet<Y.Doc>();

  public isPathDeleted(filePath: string): boolean {
    const normalized = normalizeVaultPath(filePath);

    for (const root of this.#deletedRoots) {
      if (isSamePathOrChild(root, normalized)) return true;
    }

    return false;
  }

  /** Already-deleted descendants fold into this new root. */
  public markDeleted(targetPath: string): string {
    const normalizedTarget = normalizeVaultPath(targetPath);

    for (const root of this.#deletedRoots) {
      if (isSamePathOrChild(normalizedTarget, root)) {
        this.#deletedRoots.delete(root);
      }
    }

    this.#deletedRoots.add(normalizedTarget);
    return normalizedTarget;
  }

  /** Also clears deleted roots above or below it, e.g. when a file is recreated. */
  public clearDeleted(targetPath: string): void {
    const normalizedTarget = normalizeVaultPath(targetPath);

    for (const root of this.#deletedRoots) {
      if (
        isSamePathOrChild(root, normalizedTarget) ||
        isSamePathOrChild(normalizedTarget, root)
      ) {
        this.#deletedRoots.delete(root);
      }
    }
  }

  public isDocumentInvalidated(doc: Y.Doc): boolean {
    return this.#invalidatedDocuments.has(doc);
  }

  public invalidateDocument(doc: Y.Doc): void {
    this.#invalidatedDocuments.add(doc);
  }
}
