import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "./yjs.const.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import { sendBinaryMessage } from "./yjsUtils/wsTransport.utils.ts";

/**
 * Represents a single collaborative document ("room"): its Yjs CRDT document, its awareness
 * state, and the set of WebSocket connections currently joined to it. Owned and lifecycle-managed
 * by {@link YjsRoomRegistry}; connections are attached/detached by {@link YjsCollaborationServer}.
 */
export class YjsRoom {
  /** URI-encoded document identifier, used as the persistence storage key. */
  public readonly docName: string;
  /** Normalized vault-relative file path this room represents. */
  public readonly filePath: string;
  /** The in-memory Yjs CRDT document holding the file's content. */
  public readonly doc = new Y.Doc();
  /** Awareness instance tracking ephemeral per-client state (cursors, presence) for this document. */
  public readonly awareness: awarenessProtocol.Awareness;
  /** Connections currently joined to this room, keyed by socket, with their per-connection state. */
  public readonly connections = new Map<WebSocket, YjsConnectionState>();
  /** Maps an awareness client id to the connection currently allowed to update/clear it. */
  public readonly awarenessOwners = new Map<number, WebSocket>();

  /** Resolves once persistence has finished binding state and listeners are attached; awaited before serving traffic. */
  public ready: Promise<void> = Promise.resolve();
  /** Chained promise used to process incoming messages for this room strictly in order. */
  public messageQueue: Promise<void> = Promise.resolve();
  /** Count of messages currently queued/in-flight, used to enforce {@link MAX_PENDING_MESSAGES_PER_DOCUMENT}. */
  public pendingMessages = 0;
  /** Count of in-progress "reserve" calls (registry lookups that haven't yet attached a connection), keeping the room alive during setup races. */
  public reservations = 1;
  /** Set while the room is being torn down (flushed and destroyed); non-null blocks new reservations. */
  public closingPromise: Promise<void> | null = null;

  /** Guards {@link attachListeners} so document/awareness listeners are only wired once per room. */
  private listenersAttached = false;

  public constructor(docName: string, filePath: string) {
    this.docName = docName;
    this.filePath = filePath;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
  }

  /**
   * Wires the Yjs document and awareness instance to broadcast their changes to all joined
   * connections. Idempotent: subsequent calls are no-ops.
   * @param isInvalidated - Callback checked before broadcasting a document update, to suppress
   * broadcasts for a document that was invalidated by a path deletion mid-flight.
   */
  public attachListeners(isInvalidated: () => boolean): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    this.doc.on("update", (update: Uint8Array) => {
      if (isInvalidated()) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changedClients = added.concat(updated, removed);
        if (changedClients.length === 0) return;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  /**
   * Sends a pre-encoded binary message to every connection currently joined to the room.
   * @param message - Encoded Yjs protocol message to broadcast.
   */
  public broadcast(message: Uint8Array): void {
    for (const connection of this.connections.keys()) {
      sendBinaryMessage(connection, message);
    }
  }

  /**
   * Sends the current awareness state of every known client in the room to a single connection.
   * Used both for initial sync and in response to an explicit awareness query.
   * @param connection - Connection to receive the snapshot.
   */
  public sendAwarenessSnapshot(connection: WebSocket): void {
    const clientIds = Array.from(this.awareness.getStates().keys());
    if (clientIds.length === 0) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clientIds),
    );
    sendBinaryMessage(connection, encoding.toUint8Array(encoder));
  }

  /**
   * Sends the initial handshake to a newly joined connection: a sync-step-1 message (state
   * vector) followed by the current awareness snapshot.
   * @param connection - Newly joined connection to initialize.
   */
  public sendInitialSync(connection: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    sendBinaryMessage(connection, encoding.toUint8Array(encoder));

    this.sendAwarenessSnapshot(connection);
  }

  /**
   * Called when releasing a connection that disconnected: revokes the awareness ownership
   * it controlled (broadcasting removal to remaining peers) and clears its room state.
   * No-ops if the connection was already released.
   * @param connection - Connection being removed from the room.
   */
  public releaseConnection(connection: WebSocket): void {
    const state = this.connections.get(connection);
    if (!state || state.closed) return;

    state.closed = true;
    this.connections.delete(connection);

    const ownedClientIds = Array.from(state.controlledAwarenessIds).filter(
      (clientId) => this.awarenessOwners.get(clientId) === connection,
    );

    for (const clientId of ownedClientIds) {
      this.awarenessOwners.delete(clientId);
    }

    state.controlledAwarenessIds.clear();

    if (ownedClientIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, ownedClientIds, connection);
    }
  }

  /** Destroys the awareness instance and the underlying Yjs document, releasing their resources. */
  public destroyDocument(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }
}
