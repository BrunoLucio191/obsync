import { WebSocket } from "ws";
import { closeConnection } from "./wsTransport.utils.ts";
import { isSamePathOrChild } from "./vaultPath.utils.ts";
import { DeletedPathRegistry } from "./DeletedPathRegistry.ts";
import { YjsPersistenceGateway } from "./YjsPersistenceGateway.ts";
import { YjsRoom } from "./YjsRoom.ts";

export class YjsRoomRegistry {
  private readonly rooms = new Map<string, YjsRoom>();
  private readonly deletedPaths: DeletedPathRegistry;
  private readonly persistence: YjsPersistenceGateway;

  public constructor(
    deletedPaths: DeletedPathRegistry,
    persistence: YjsPersistenceGateway,
  ) {
    this.deletedPaths = deletedPaths;
    this.persistence = persistence;
  }

  public reserve(docName: string, filePath: string): YjsRoom | null {
    const existing = this.rooms.get(docName);

    if (existing) {
      // Uma nova conexão durante o flush final deve reconectar alguns
      // instantes depois, em vez de entrar em uma geração de sala que está
      // sendo destruída.
      if (existing.closingPromise) return null;

      existing.reservations += 1;
      return existing;
    }

    return this.create(docName, filePath);
  }

  public release(room: YjsRoom, connection: WebSocket): void {
    room.releaseConnection(connection);
    this.scheduleCleanup(room);
  }

  public invalidateUnderPath(targetPath: string): void {
    for (const room of this.rooms.values()) {
      if (!isSamePathOrChild(targetPath, room.filePath)) continue;

      this.deletedPaths.invalidateDocument(room.doc);

      for (const connection of room.connections.keys()) {
        closeConnection(connection, 1008, "Path deleted");
      }
    }
  }

  private create(docName: string, filePath: string): YjsRoom {
    const room = new YjsRoom(docName, filePath);
    this.rooms.set(docName, room);

    room.ready = (async () => {
      await this.persistence.bindState(docName, room.doc);
      room.attachListeners(() =>
        this.deletedPaths.isDocumentInvalidated(room.doc),
      );
    })().catch((error: unknown) => {
      if (this.rooms.get(docName) === room) {
        this.rooms.delete(docName);
      }

      for (const connection of room.connections.keys()) {
        closeConnection(connection, 1011, "Document initialization failed");
      }

      room.destroyDocument();
      throw error;
    });

    return room;
  }

  private scheduleCleanup(room: YjsRoom): void {
    if (
      room.connections.size > 0 ||
      room.reservations > 0 ||
      room.closingPromise
    ) {
      return;
    }

    room.closingPromise = (async () => {
      await room.messageQueue;

      if (room.connections.size > 0 || room.reservations > 0) {
        return;
      }

      await room.ready;
      await this.persistence.writeState(room.docName, room.doc);

      if (room.connections.size > 0 || room.reservations > 0) return;
      if (this.rooms.get(room.docName) !== room) return;

      this.rooms.delete(room.docName);
      await this.persistence.destroyState(room.docName, room.doc);
      room.destroyDocument();
    })()
      .catch((error: unknown) => {
        console.error(
          `[Yjs] Não foi possível finalizar a sala ${room.filePath}:`,
          error,
        );
      })
      .finally(() => {
        room.closingPromise = null;
      });
  }
}
