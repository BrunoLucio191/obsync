import { EventEmitter } from "node:events";

export type VaultChange =
  | { type: "create"; path: string; isFolder: boolean; content: string; originClientId?: string }
  | { type: "delete"; path: string; isFolder: boolean; originClientId?: string }
  | { type: "modify"; path: string; content: string; originClientId?: string }
  | { type: "rename"; oldPath: string; newPath: string; originClientId?: string };

export const vaultEvents = new EventEmitter();

export function publishVaultChange(change: VaultChange): void {
  vaultEvents.emit("change", change);
}
