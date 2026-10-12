import { WebSocket } from "ws";
import { closeConnection } from "../yjsUtils/wsTransport.utils.ts";
import { isSamePathOrChild } from "../yjsUtils/vaultPath.utils.ts";
import { DeletedPathRegistry } from "../DeletedPathRegistry.ts";
import { YjsRoom } from "./YjsRoom.ts";
import type { YjsPersistence } from "../YjsPersistence.ts";

/** A room lives while it has connections or reservations, then is flushed and destroyed. */
export class YjsRoomRegistry {
  readonly #rooms = new Map<string, YjsRoom>();
  readonly #deletedPaths: DeletedPathRegistry;
  readonly #persistence: YjsPersistence;

  public constructor(
    deletedPaths: DeletedPathRegistry,
    persistence: YjsPersistence,
  ) {
    this.#deletedPaths = deletedPaths;
    this.#persistence = persistence;
  }

  /** The reservation keeps the room alive until the caller attaches its connection. */
  public reserve(docName: string, filePath: string): YjsRoom | null {
    const existing = this.#rooms.get(docName);

    if (existing) {
      if (existing.closingPromise) return null;

      existing.reservations += 1;
      return existing;
    }

    return this.#create(docName, filePath);
  }

  public release(room: YjsRoom, connection: WebSocket): void {
    room.releaseConnection(connection);
    this.#scheduleCleanup(room);
  }

  public invalidateUnderPath(targetPath: string): void {
    for (const room of this.#rooms.values()) {
      if (!isSamePathOrChild(targetPath, room.filePath)) continue;

      this.#deletedPaths.invalidateDocument(room.doc);

      for (const connection of room.connections.keys()) {
        closeConnection(connection, 1008, "Path deleted");
      }
    }
  }
  /** returns the room that matches a given path */
  public findRoomByPath(filePath: string) {
    for (const room of this.#rooms.values()) {
      if (room.filePath === filePath) return room;
    }
  }

  #create(docName: string, filePath: string): YjsRoom {
    const room = new YjsRoom(docName, filePath);
    this.#rooms.set(docName, room);

    room.ready = (async () => {
      await this.#persistence.bindState(docName, room.doc);
      room.attachListeners(() =>
        this.#deletedPaths.isDocumentInvalidated(room.doc),
      );
    })().catch((error: unknown) => {
      if (this.#rooms.get(docName) === room) {
        this.#rooms.delete(docName);
      }

      for (const connection of room.connections.keys()) {
        closeConnection(connection, 1011, "Document initialization failed");
      }

      room.destroyDocument();
      throw error;
    });

    return room;
  }

  /** Re-checks after each await, so a connection arriving mid-flush cancels the teardown. */
  #scheduleCleanup(room: YjsRoom): void {
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
      await this.#persistence.writeState(room.docName, room.doc);

      if (room.connections.size > 0 || room.reservations > 0) return;
      if (this.#rooms.get(room.docName) !== room) return;

      this.#rooms.delete(room.docName);
      await this.#persistence.destroyState(room.docName, room.doc);
      room.destroyDocument();
    })()
      .catch((error: unknown) => {
        console.error(`[Yjs] Could not finalize room ${room.filePath}:`, error);
      })
      .finally(() => {
        room.closingPromise = null;
      });
  }
}
