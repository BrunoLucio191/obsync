import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "./yjs.cons.ts";
import type { YjsConnectionState } from "./yjs.types.ts";
import { sendBinaryMessage } from "./wsTransport.utils.ts";

export class YjsRoom {
  public readonly docName: string;
  public readonly filePath: string;
  public readonly doc = new Y.Doc();
  public readonly awareness: awarenessProtocol.Awareness;
  public readonly connections = new Map<WebSocket, YjsConnectionState>();
  public readonly awarenessOwners = new Map<number, WebSocket>();

  public ready: Promise<void> = Promise.resolve();
  public messageQueue: Promise<void> = Promise.resolve();
  public pendingMessages = 0;
  public reservations = 1;
  public closingPromise: Promise<void> | null = null;

  private listenersAttached = false;

  public constructor(docName: string, filePath: string) {
    this.docName = docName;
    this.filePath = filePath;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
  }

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
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const changedClients = added.concat(updated, removed);
        if (changedClients.length === 0) return;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            changedClients,
          ),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  public broadcast(message: Uint8Array): void {
    for (const connection of this.connections.keys()) {
      sendBinaryMessage(connection, message);
    }
  }

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

  public sendInitialSync(connection: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    sendBinaryMessage(connection, encoding.toUint8Array(encoder));

    this.sendAwarenessSnapshot(connection);
  }

  // Chamada pelo release de uma conexão que se desconectou: revoga o
  // ownership de awareness que ela controlava e limpa seu estado de sala.
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
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        ownedClientIds,
        connection,
      );
    }
  }

  public destroyDocument(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }
}
