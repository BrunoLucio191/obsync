import { EventEmitter } from "node:events";

/** `originClientId` lets the client that made the change ignore its own echo. */
export type VaultChange =
  | {
      type: "create";
      path: string;
      isFolder: boolean;
      content?: string;
      isBinary?: boolean;
      originClientId?: string;
    }
  | { type: "delete"; path: string; isFolder: boolean; originClientId?: string }
  | { type: "modify"; path: string; content: string; originClientId?: string }
  | {
      type: "rename";
      oldPath: string;
      newPath: string;
      isFolder: boolean;
      originClientId?: string;
    };

export const vaultEvents = new EventEmitter();

export function publishVaultChange(change: VaultChange): void {
  vaultEvents.emit("change", change);
}
