import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_SYNC } from "./yjs.cons.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import {
  ensureDecoderConsumed,
  readBoundedByteArray,
  sendBinaryMessage,
} from "./wsTransport.utils.ts";
import type { YjsRoom } from "./YjsRoom.ts";

export class SyncMessageHandler {
  public handle(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    decoder: decoding.Decoder,
  ): void {
    const syncMessageType = decoding.readVarUint(decoder);

    switch (syncMessageType) {
      case syncProtocol.messageYjsSyncStep1: {
        const remoteStateVector = readBoundedByteArray(
          decoder,
          "State Vector",
        );
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
              syncMessageType === syncProtocol.messageYjsSyncStep2
                ? "yjs-sync-step2"
                : "yjs-update",
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
        throw new Error(
          `Unknown internal Yjs sync message type: ${syncMessageType}`,
        );
    }
  }
}
