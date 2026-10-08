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

/** Updates from a connection without global write access are dropped and audited. */
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
