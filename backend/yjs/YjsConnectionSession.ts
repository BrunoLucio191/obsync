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
import type { AwarenessOwnershipGuard } from "./AwarenessOwnershipGuard.ts";
import type { YjsRoom } from "./yjsRooms/YjsRoom.ts";

/**
 * Owns message handling for a single connection joined to a single {@link YjsRoom}: validates
 * and queues incoming raw WebSocket frames onto the room's ordered message queue, then decodes
 * and routes each one to the appropriate sync/awareness handler.
 */
export class YjsConnectionSession {
  /** Room this session's connection is joined to. */
  private readonly room: YjsRoom;
  /** The WebSocket connection this session handles messages for. */
  private readonly connection: WebSocket;
  /** Per-connection state (identity, permissions, closed flag). */
  private readonly connectionState: YjsConnectionState;
  /** Shared registry used to check whether the room's document/path has been invalidated. */
  private readonly deletedPaths: DeletedPathRegistry;
  /** Shared handler for `y-protocols/sync` sub-messages. */
  private readonly syncHandler: SyncMessageHandlerFn;
  /** Shared guard enforcing awareness ownership rules. */
  private readonly awarenessGuard: AwarenessOwnershipGuard;

  public constructor(
    room: YjsRoom,
    connection: WebSocket,
    connectionState: YjsConnectionState,
    deletedPaths: DeletedPathRegistry,
    syncHandler: SyncMessageHandlerFn,
    awarenessGuard: AwarenessOwnershipGuard,
  ) {
    this.room = room;
    this.connection = connection;
    this.connectionState = connectionState;
    this.deletedPaths = deletedPaths;
    this.syncHandler = syncHandler;
    this.awarenessGuard = awarenessGuard;
  }

  /**
   * Entry point for a raw WebSocket frame. Rejects non-binary frames (the Yjs protocol is
   * binary-only) and otherwise hands the message off to be queued for ordered processing.
   * @param rawData - Raw frame payload as delivered by `ws`.
   * @param isBinary - Whether the frame was sent as binary.
   */
  public handleRawMessage(rawData: RawData, isBinary: boolean): void {
    if (!isBinary) {
      closeConnection(this.connection, 1003, "Binary messages required");
      return;
    }

    this.enqueueMessage(toUint8Array(rawData));
  }

  /**
   * Appends a message to the room's shared processing queue so messages are handled strictly
   * in arrival order across all of the room's connections, awaiting room readiness first.
   * Closes the connection if the room's pending-message limit is exceeded or if processing throws.
   * @param message - Decoded (non-empty framing aside) message bytes to process.
   */
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
        console.error(`[Yjs] Invalid message in ${room.filePath}:`, error);
        closeConnection(this.connection, 1007, "Invalid Yjs payload");
      })
      .finally(() => {
        room.pendingMessages -= 1;
      });
  }

  /**
   * Validates and routes a single dequeued message to the correct handler based on its
   * top-level message type tag ({@link MESSAGE_SYNC}, {@link MESSAGE_AWARENESS}, etc.).
   * @param message - Raw message bytes, expected to start with a var-uint message type tag.
   * @throws If the message is empty, exceeds the max size (handled via connection close instead
   * for that case), carries a `MESSAGE_AUTH` tag, or has an unrecognized message type.
   */
  private processMessage(message: Uint8Array): void {
    if (message.byteLength === 0) {
      throw new Error("Empty Yjs WebSocket message.");
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
        this.syncHandler({
          room: this.room,
          connection: this.connection,
          connectionState: this.connectionState,
          decoder,
        });
        return;

      case MESSAGE_AWARENESS: {
        const update = readBoundedByteArray(decoder, "Awareness update");
        ensureDecoderConsumed(decoder);
        this.awarenessGuard.applyUpdate(this.room, this.connection, this.connectionState, update);
        return;
      }

      case MESSAGE_QUERY_AWARENESS:
        ensureDecoderConsumed(decoder);
        this.room.sendAwarenessSnapshot(this.connection);
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
