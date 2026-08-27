import { EventEmitter } from "node:events";

/**
 * A single change made to a file or folder in a synced vault, as broadcast
 * across the backend's internal event bus. The `originClientId`, when
 * present, identifies the client that produced the change so it can be
 * excluded from receiving its own echoed update.
 */
export type VaultChange =
  | { type: "create"; path: string; isFolder: boolean; content: string; originClientId?: string }
  | { type: "delete"; path: string; isFolder: boolean; originClientId?: string }
  | { type: "modify"; path: string; content: string; originClientId?: string }
  | { type: "rename"; oldPath: string; newPath: string; originClientId?: string };

/**
 * Process-wide event bus used to broadcast vault changes to interested
 * backend components (e.g. sync/notification handlers) without coupling
 * them directly to whatever produced the change.
 */
export const vaultEvents = new EventEmitter();

/** Publishes a vault change on {@link vaultEvents} so all subscribers are notified. */
export function publishVaultChange(change: VaultChange): void {
  vaultEvents.emit("change", change);
}
