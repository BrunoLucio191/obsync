import type * as Y from "yjs";
import { isSamePathOrChild, normalizeVaultPath } from "./vaultPath.utils.ts";

export class DeletedPathRegistry {
  private readonly deletedRoots = new Set<string>();
  private readonly invalidatedDocuments = new WeakSet<Y.Doc>();

  public isPathDeleted(filePath: string): boolean {
    const normalized = normalizeVaultPath(filePath);

    for (const root of this.deletedRoots) {
      if (isSamePathOrChild(root, normalized)) return true;
    }

    return false;
  }

  // Retorna a forma normalizada para quem precisa invalidar salas ativas.
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

  public clearDeleted(targetPath: string): void {
    const normalizedTarget = normalizeVaultPath(targetPath);

    for (const root of this.deletedRoots) {
      if (
        isSamePathOrChild(root, normalizedTarget) ||
        isSamePathOrChild(normalizedTarget, root)
      ) {
        this.deletedRoots.delete(root);
      }
    }
  }

  public isDocumentInvalidated(doc: Y.Doc): boolean {
    return this.invalidatedDocuments.has(doc);
  }

  public invalidateDocument(doc: Y.Doc): void {
    this.invalidatedDocuments.add(doc);
  }
}
