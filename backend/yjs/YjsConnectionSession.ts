import * as decoding from "lib0/decoding";
import { WebSocket, type RawData } from "ws";
import {
  MAX_PENDING_MESSAGES_PER_DOCUMENT,
  MAX_WS_MESSAGE_BYTES,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
} from "./yjs.cons.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import {
  closeConnection,
  ensureDecoderConsumed,
  readBoundedByteArray,
  toUint8Array,
} from "./wsTransport.utils.ts";
import type { DeletedPathRegistry } from "./DeletedPathRegistry.ts";
import type { SyncMessageHandler } from "./SyncMessageHandler.ts";
import type { AwarenessOwnershipGuard } from "./AwarenessOwnershipGuard.ts";
import type { YjsRoom } from "./YjsRoom.ts";

export class YjsConnectionSession {
  private readonly room: YjsRoom;
  private readonly connection: WebSocket;
  private readonly connectionState: YjsConnectionState;
  private readonly deletedPaths: DeletedPathRegistry;
  private readonly syncHandler: SyncMessageHandler;
  private readonly awarenessGuard: AwarenessOwnershipGuard;

  public constructor(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    deletedPaths: DeletedPathRegistry,
    syncHandler: SyncMessageHandler,
    awarenessGuard: AwarenessOwnershipGuard,
  ) {
    this.room = room;
    this.connection = connection;
    this.connectionState = connectionState;
    this.deletedPaths = deletedPaths;
    this.syncHandler = syncHandler;
    this.awarenessGuard = awarenessGuard;
  }

  public handleRawMessage(rawData: RawData, isBinary: boolean): void {
    if (!isBinary) {
      closeConnection(this.connection, 1003, "Binary messages required");
      return;
    }

    this.enqueueMessage(toUint8Array(rawData));
  }

  private enqueueMessage(message: Uint8Array): void {
    const room = this.room;
    room.pendingMessages += 1;

    if (room.pendingMessages > MAX_PENDING_MESSAGES_PER_DOCUMENT) {
      room.pendingMessages -= 1;
      closeConnection(this.connection, 1013, "Document queue overloaded");
      return;
    }

    const task = room.messageQueue.then(async () => {
      await room.ready;

      if (this.connectionState.closed) return;
      this.processMessage(message);
    });

    room.messageQueue = task
      .catch((error: unknown) => {
        console.error(`[Yjs] Mensagem inválida em ${room.filePath}:`, error);
        closeConnection(this.connection, 1007, "Invalid Yjs payload");
      })
      .finally(() => {
        room.pendingMessages -= 1;
      });
  }

  private processMessage(message: Uint8Array): void {
    if (message.byteLength === 0) {
      throw new Error("Mensagem WebSocket Yjs vazia.");
    }

    if (message.byteLength > MAX_WS_MESSAGE_BYTES) {
      closeConnection(this.connection, 1009, "Message too large");
      return;
    }

    if (
      this.deletedPaths.isDocumentInvalidated(this.room.doc) ||
      this.deletedPaths.isPathDeleted(this.room.filePath)
    ) {
      closeConnection(this.connection, 1008, "Document deleted");
      return;
    }

    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.syncHandler.handle(
          this.room,
          this.connection,
          this.connectionState,
          decoder,
        );
        return;

      case MESSAGE_AWARENESS: {
        const update = readBoundedByteArray(decoder, "Awareness update");
        ensureDecoderConsumed(decoder);
        this.awarenessGuard.applyUpdate(
          this.room,
          this.connection,
          this.connectionState,
          update,
        );
        return;
      }

      case MESSAGE_QUERY_AWARENESS:
        ensureDecoderConsumed(decoder);
        this.room.sendAwarenessSnapshot(this.connection);
        return;

      case MESSAGE_AUTH:
        throw new Error(
          "Mensagens de autenticação dentro do protocolo Yjs não são aceitas; use o ticket do handshake WebSocket.",
        );

      default:
        throw new Error(`Tipo de mensagem Yjs desconhecido: ${messageType}`);
    }
  }
}
