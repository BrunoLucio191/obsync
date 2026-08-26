import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import { getYjsDebugConnection } from "../yjsDebug.ts";
import { MAX_AWARENESS_ENTRIES_PER_MESSAGE } from "./yjs.cons.ts";
import type { YjsAwarenessEntry, YjsConnectionState } from "./yjs.types.ts";
import {
  getAwarenessPresenceIdentity,
  normalizePresenceIdentity,
} from "./presence.utils.ts";
import { ensureDecoderConsumed } from "./wsTransport.utils.ts";
import type { YjsRoom } from "./YjsRoom.ts";

export class AwarenessOwnershipGuard {
  public applyUpdate(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    update: Uint8Array,
  ): void {
    const entries = this.parseEntries(update);
    const authenticatedPresenceId = connectionState.authenticatedPresenceId;
    const acceptedEntries: YjsAwarenessEntry[] = [];
    const ignoredEntries: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      const currentOwner = room.awarenessOwners.get(entry.clientId);

      if (entry.state === null) {
        // y-websocket can echo back remote awareness snapshots. A connection
        // can only remove clientIds it actually controls.
        if (currentOwner !== connection) {
          ignoredEntries.push({
            clientId: entry.clientId,
            reason: "foreign-removal-echo",
            currentOwner: currentOwner
              ? this.describeConnection(currentOwner)
              : null,
          });
          continue;
        }

        acceptedEntries.push(entry);
        continue;
      }

      const presenceId = getAwarenessPresenceIdentity(entry.state);

      // The awareness identity must match the identity authenticated at the
      // HTTP upgrade. This discards remote snapshots re-sent by the
      // provider, such as one user accidentally sending another user's state.
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
        const currentOwnerContext = getYjsDebugConnection(currentOwner);
        const currentOwnerPresenceId = normalizePresenceIdentity(
          currentOwnerContext.userEmail,
        );

        if (currentOwnerPresenceId !== authenticatedPresenceId) {
          // A real collision between different users must not drop any
          // socket or silently transfer ownership.
          ignoredEntries.push({
            clientId: entry.clientId,
            reason: "cross-user-client-id-collision",
            currentOwner: this.describeConnection(currentOwner),
            attemptedOwner: this.describeConnection(connection),
          });
          continue;
        }

        // Reconnection of the same user. Ownership can move to the new
        // socket, but the old socket is not closed: this avoids a
        // connection ping-pong.
        room.connections
          .get(currentOwner)
          ?.controlledAwarenessIds.delete(entry.clientId);
      }

      acceptedEntries.push(entry);
    }

    if (ignoredEntries.length > 0) {
      console.warn(
        `[Yjs] Ignored awareness entries in ${room.filePath}:`,
        ignoredEntries,
      );
    }

    if (acceptedEntries.length === 0) return;

    const filteredUpdate = this.encodeEntries(acceptedEntries);
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

  private describeConnection(connection: WebSocket): unknown {
    const context = getYjsDebugConnection(connection);

    return {
      connectionId: context.connectionId,
      userId: context.userId,
      userEmail: context.userEmail,
      userRole: context.userRole,
    };
  }

  private parseEntries(update: Uint8Array): YjsAwarenessEntry[] {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);

    if (count > MAX_AWARENESS_ENTRIES_PER_MESSAGE) {
      throw new Error("The awareness message has too many entries.");
    }

    const entries: YjsAwarenessEntry[] = [];

    for (let index = 0; index < count; index += 1) {
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

  private encodeEntries(entries: readonly YjsAwarenessEntry[]): Uint8Array {
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
