import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_SYNC } from "./yjs.const.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import {
  ensureDecoderConsumed,
  readBoundedByteArray,
  sendBinaryMessage,
} from "./yjsUtils/wsTransport.utils.ts";
import type { YjsRoom } from "./yjsRooms/YjsRoom.ts";

/**
 * Handles the `y-protocols/sync` sub-protocol nested inside a {@link MESSAGE_SYNC} envelope:
 * responding to state-vector requests and applying incoming document updates, subject to a
 * write-access check.
 * Dispatches a decoded sync sub-message: replies with sync-step-2 for a sync-step-1 request,
 * or applies the update to the document for sync-step-2/update messages (only if the
 * connection has global write access; otherwise the update is silently dropped and audited).
 * @param room - Room whose document is being synced.
 * @param connection - Connection the message came from (and, for step-1, the reply target).
 * @param connectionState - Per-connection state, used to check write permission.
 * @param decoder - Decoder positioned right after the outer {@link MESSAGE_SYNC} tag, at the
 * start of the sync sub-message.
 * @throws If the sync sub-message type is unrecognized.
 */
export type SyncMessageHandlerFn = (params: SyncMessageHandlerParams) => void;

export type SyncMessageHandlerParams = {
  room: YjsRoom;
  connection: WebSocket;
  connectionState: YjsConnectionState;
  decoder: decoding.Decoder;
};

export function syncMessageHandler({
  room,
  connection,
  connectionState,
  decoder,
}: SyncMessageHandlerParams): void {
  const syncMessageType = decoding.readVarUint(decoder);

  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1: {
      const remoteStateVector = readBoundedByteArray(decoder, "State Vector");
      ensureDecoderConsumed(decoder);

      const response = encoding.createEncoder();
      encoding.writeVarUint(response, MESSAGE_SYNC);
      syncProtocol.writeSyncStep2(response, room.doc, remoteStateVector);
      sendBinaryMessage(connection, encoding.toUint8Array(response));

      return;
    }

    case syncProtocol.messageYjsSyncStep2:
    case syncProtocol.messageYjsUpdate: {
      const update = readBoundedByteArray(decoder, "Update Yjs");
      ensureDecoderConsumed(decoder);

      if (!connectionState.canWriteGlobal) {
        console.warn("[Audit] Global Yjs update blocked", {
          userId: connectionState.userId,
          role: connectionState.userRole,
          operation:
            syncMessageType === syncProtocol.messageYjsSyncStep2 ? "yjs-sync-step2" : "yjs-update",
          path: room.filePath,
          timestamp: new Date().toISOString(),
          allowed: false,
        });

        return;
      }

      Y.applyUpdate(room.doc, update, connection);

      return;
    }

    default:
      throw new Error(`Unknown internal Yjs sync message type: ${syncMessageType}`);
  }
}
