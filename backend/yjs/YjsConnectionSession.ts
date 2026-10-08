import * as decoding from "lib0/decoding";
import { WebSocket, type RawData } from "ws";
import {
  MAX_PENDING_MESSAGES_PER_DOCUMENT,
  MAX_WS_MESSAGE_BYTES,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
} from "./yjs.const.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import {
  closeConnection,
  ensureDecoderConsumed,
  readBoundedByteArray,
  toUint8Array,
} from "./yjsUtils/wsTransport.utils.ts";
import type { DeletedPathRegistry } from "./DeletedPathRegistry.ts";
import type { SyncMessageHandlerFn } from "./SyncMessageHandler.ts";
import { applyAwerenessUpdate } from "./YjsApplyAwerenessUpdate.ts";
import type { YjsRoom } from "./yjsRooms/YjsRoom.ts";
import type { WebSocketMessageCounter } from "./yjsUtils/MessageCounter.utils.ts";

export class YjsConnectionSession {
  readonly #room: YjsRoom;
  readonly #connection: WebSocket;
  readonly #connectionState: YjsConnectionState;
  readonly #deletedPaths: DeletedPathRegistry;
  readonly #syncHandler: SyncMessageHandlerFn;
  readonly #messageCounter: WebSocketMessageCounter<WebSocket, number>;

  public constructor(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    deletedPaths: DeletedPathRegistry,
    syncHandler: SyncMessageHandlerFn,
    messageCounter: WebSocketMessageCounter<WebSocket, number>,
  ) {
    this.#room = room;
    this.#connection = connection;
    this.#connectionState = connectionState;
    this.#deletedPaths = deletedPaths;
    this.#syncHandler = syncHandler;
    this.#messageCounter = messageCounter;
  }

  /** Receives the raw message and adds that to the queue
   * @param rawData
   * @param isBinary - if the data received is not binary, the connection is closed
   */
  public handleRawMessage(rawData: RawData, isBinary: boolean): void {
    if (!isBinary) {
      closeConnection(this.#connection, 1003, "Binary messages required");
      return;
    }

    this.#enqueueMessage(toUint8Array(rawData));
  }

  /** One queue per room, so messages from all its connections run in arrival order. */
  #enqueueMessage(message: Uint8Array): void {
    const room = this.#room;
    room.pendingMessages += 1;

    this.#messageCounter.increment(this.#connection);

    if (room.pendingMessages >= MAX_PENDING_MESSAGES_PER_DOCUMENT) {
      const connectionToClose = this.#messageCounter.biggest();
      room.pendingMessages -= 1;

      if (connectionToClose) {
        closeConnection(connectionToClose, 1013, "Document queue overloaded");
        this.#messageCounter.delete(connectionToClose);
      }
      return;
    }

    const task = room.messageQueue.then(async () => {
      await room.ready;

      if (this.#connectionState.closed) return;
      this.#processMessage(message);
    });

    room.messageQueue = task
      .catch((error: unknown) => {
        console.error(`[Yjs] Invalid message in ${room.filePath}:`, error);
        closeConnection(this.#connection, 1007, "Invalid Yjs payload");
      })
      .finally(() => {
        this.#messageCounter.decrement(this.#connection);
        room.pendingMessages -= 1;
      });
  }

  #processMessage(message: Uint8Array): void {
    if (message.byteLength === 0) {
      throw new Error("Empty Yjs WebSocket message.");
    }

    if (message.byteLength > MAX_WS_MESSAGE_BYTES) {
      closeConnection(this.#connection, 1009, "Message too large");
      return;
    }

    if (
      this.#deletedPaths.isDocumentInvalidated(this.#room.doc) ||
      this.#deletedPaths.isPathDeleted(this.#room.filePath)
    ) {
      closeConnection(this.#connection, 1008, "Document deleted");
      return;
    }

    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.#syncHandler({
          room: this.#room,
          connection: this.#connection,
          connectionState: this.#connectionState,
          decoder,
        });
        return;

      case MESSAGE_AWARENESS: {
        const update = readBoundedByteArray(decoder, "Awareness update");
        ensureDecoderConsumed(decoder);
        applyAwerenessUpdate(this.#room, this.#connection, update);
        return;
      }

      case MESSAGE_QUERY_AWARENESS:
        ensureDecoderConsumed(decoder);
        this.#room.sendAwarenessSnapshot(this.#connection);
        return;

      case MESSAGE_AUTH:
        throw new Error(
          "Authentication messages inside the Yjs protocol are not accepted; use the WebSocket handshake ticket instead.",
        );

      default:
        throw new Error(`Unknown Yjs message type: ${messageType}`);
    }
  }
}
