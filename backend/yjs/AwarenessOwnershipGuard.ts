import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import { MAX_AWARENESS_ENTRIES_PER_MESSAGE } from "./yjs.const.ts";
import type { YjsAwarenessEntry, YjsConnectionState } from "./yjs.types.ts";
import {
  getAwarenessPresenceIdentity,
  normalizePresenceIdentity,
} from "./yjsUtils/presence.utils.ts";
import { ensureDecoderConsumed } from "./yjsUtils/wsTransport.utils.ts";
import type { YjsRoom } from "./yjsRooms/YjsRoom.ts";
import type { WebSocketAuthorization } from "../auth/tokenService.types.ts";

type userConnectionContext = {
  userId: number;
  userEmail: string;
  userRole: string;
};
/** A connection only claims or removes awareness ids of its own user, so nobody spoofs or evicts another's cursor. */
export class AwarenessOwnershipGuard {
  readonly #authenticatedConnections: Map<WebSocket, WebSocketAuthorization>;
  constructor(
    authenticatedConnections: Map<WebSocket, WebSocketAuthorization>,
  ) {
    this.#authenticatedConnections = authenticatedConnections;
  }
  public applyUpdate(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    update: Uint8Array,
  ): void {
    const entries = this.#parseEntries(update);
    const authenticatedPresenceId = connectionState.authenticatedPresenceId;
    const acceptedEntries: YjsAwarenessEntry[] = [];
    const ignoredEntries: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      const currentOwner = room.awarenessOwners.get(entry.clientId);

      if (entry.state === null) {
        // y-websocket can echo remote snapshots back: only the owner may remove a clientId
        if (currentOwner !== connection) {
          ignoredEntries.push({
            clientId: entry.clientId,
            reason: "foreign-removal-echo",
            currentOwner: currentOwner
              ? this.#describeConnection(currentOwner)
              : null,
          });
          continue;
        }
        acceptedEntries.push(entry);
        continue;
      }

      const presenceId = getAwarenessPresenceIdentity(entry.state);

      // Must match the identity authenticated at the upgrade, which drops snapshots the provider re-sends
      if (
        authenticatedPresenceId === null ||
        presenceId === null ||
        presenceId !== authenticatedPresenceId
      ) {
        ignoredEntries.push({
          clientId: entry.clientId,
          reason: "remote-awareness-echo",
          presenceId,
          authenticatedPresenceId,
        });
        continue;
      }

      if (currentOwner && currentOwner !== connection) {
        const currentOwnerContext = this.#describeConnection(connection);
        const currentOwnerPresenceId = normalizePresenceIdentity(
          currentOwnerContext.userEmail,
        );

        if (currentOwnerPresenceId !== authenticatedPresenceId) {
          ignoredEntries.push({
            clientId: entry.clientId,
            reason: "cross-user-client-id-collision",
            currentOwner: this.#describeConnection(currentOwner),
            attemptedOwner: this.#describeConnection(connection),
          });
          continue;
        }

        room.connections
          .get(currentOwner)
          ?.controlledAwarenessIds.delete(entry.clientId);
      }

      acceptedEntries.push(entry);
    }
    if (acceptedEntries.length === 0) return;

    const filteredUpdate = this.#encodeEntries(acceptedEntries);
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      filteredUpdate,
      connection,
    );

    for (const entry of acceptedEntries) {
      if (entry.state === null) {
        room.awarenessOwners.delete(entry.clientId);
        connectionState.controlledAwarenessIds.delete(entry.clientId);
        continue;
      }

      room.awarenessOwners.set(entry.clientId, connection);
      connectionState.controlledAwarenessIds.add(entry.clientId);
    }
  }

  #describeConnection(connection: WebSocket): userConnectionContext {
    const context = this.#authenticatedConnections.get(connection);

    return {
      userId: context!.user.id,
      userEmail: context!.user.email,
      userRole: context!.user.role,
    };
  }

  #parseEntries(update: Uint8Array): YjsAwarenessEntry[] {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);

    if (count > MAX_AWARENESS_ENTRIES_PER_MESSAGE) {
      throw new Error("The awareness message has too many entries.");
    }

    const entries: YjsAwarenessEntry[] = [];

    for (let index = 0; index < count; index++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const stateJson = decoding.readVarString(decoder);

      let state: unknown;
      try {
        state = JSON.parse(stateJson) as unknown;
      } catch {
        throw new Error("Invalid awareness state.");
      }

      entries.push({ clientId, clock, state });
    }

    ensureDecoderConsumed(decoder);
    return entries;
  }

  #encodeEntries(entries: readonly YjsAwarenessEntry[]): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, entries.length);

    for (const entry of entries) {
      encoding.writeVarUint(encoder, entry.clientId);
      encoding.writeVarUint(encoder, entry.clock);
      encoding.writeVarString(encoder, JSON.stringify(entry.state));
    }

    return encoding.toUint8Array(encoder);
  }
}
