import type * as Y from "yjs";
import { isSamePathOrChild, normalizeVaultPath } from "./yjsUtils/vaultPath.utils.ts";

/**
 * Tracks vault paths (files/folders) that have been deleted so new Yjs connections to them
 * can be rejected and existing rooms/documents under them can be invalidated, even while
 * a race with an in-flight room creation or persistence flush is still resolving.
 */
export class DeletedPathRegistry {
  /** Normalized paths (files or folder roots) currently considered deleted. */
  private readonly deletedRoots = new Set<string>();
  /** Yjs documents that were live when their path was deleted, so message handling can be short-circuited for them. */
  private readonly invalidatedDocuments = new WeakSet<Y.Doc>();

  /**
   * Checks whether a path is deleted, either directly or because it is nested under a deleted folder.
   * @param filePath - Vault path to check (not required to be pre-normalized).
   * @returns `true` if the path or one of its ancestors was marked deleted.
   */
  public isPathDeleted(filePath: string): boolean {
    const normalized = normalizeVaultPath(filePath);

    for (const root of this.deletedRoots) {
      if (isSamePathOrChild(root, normalized)) return true;
    }

    return false;
  }

  /**
   * Marks a path as deleted, collapsing any already-deleted descendants into this new root
   * (e.g. deleting a folder after its files were individually marked deleted).
   * @param targetPath - Vault path that was deleted.
   * @returns The normalized form of `targetPath`, for callers that need to invalidate active rooms.
   */
  public markDeleted(targetPath: string): string {
    const normalizedTarget = normalizeVaultPath(targetPath);

    for (const root of this.deletedRoots) {
      if (isSamePathOrChild(normalizedTarget, root)) {
        this.deletedRoots.delete(root);
      }
    }

    this.deletedRoots.add(normalizedTarget);
    return normalizedTarget;
  }

  /**
   * Removes a path (and any deleted root that overlaps it, in either direction) from the
   * deleted set, e.g. when a file is recreated or restored.
   * @param targetPath - Vault path that should no longer be considered deleted.
   */
  public clearDeleted(targetPath: string): void {
    const normalizedTarget = normalizeVaultPath(targetPath);

    for (const root of this.deletedRoots) {
      if (isSamePathOrChild(root, normalizedTarget) || isSamePathOrChild(normalizedTarget, root)) {
        this.deletedRoots.delete(root);
      }
    }
  }

  /**
   * Checks whether a specific in-memory Yjs document instance was invalidated by a path deletion.
   * @param doc - Yjs document instance to check.
   * @returns `true` if the document was invalidated.
   */
  public isDocumentInvalidated(doc: Y.Doc): boolean {
    return this.invalidatedDocuments.has(doc);
  }

  /**
   * Flags a Yjs document instance as invalidated, so it stops accepting/broadcasting updates.
   * @param doc - Yjs document instance to invalidate.
   */
  public invalidateDocument(doc: Y.Doc): void {
    this.invalidatedDocuments.add(doc);
  }
}
