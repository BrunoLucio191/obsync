import { WebSocket } from "ws";
import { closeConnection } from "./yjsUtils/wsTransport.utils.ts";
import { isSamePathOrChild } from "./yjsUtils/vaultPath.utils.ts";
import { DeletedPathRegistry } from "./DeletedPathRegistry.ts";
import { YjsPersistenceGateway } from "./YjsPersistenceGateway.ts";
import { YjsRoom } from "./YjsRoom.ts";

/**
 * Owns the lifecycle of all active {@link YjsRoom} instances: creating them on first access,
 * loading/flushing their persisted state, and destroying them once they have no more connections
 * or pending reservations. Also propagates path-deletion invalidation to affected rooms.
 */
export class YjsRoomRegistry {
  /** Active rooms keyed by their encoded `docName`. */
  private readonly rooms = new Map<string, YjsRoom>();
  /** Shared registry of deleted vault paths, consulted when creating/invalidating rooms. */
  private readonly deletedPaths: DeletedPathRegistry;
  /** Persistence backend used to hydrate/flush room documents. */
  private readonly persistence: YjsPersistenceGateway;

  public constructor(deletedPaths: DeletedPathRegistry, persistence: YjsPersistenceGateway) {
    this.deletedPaths = deletedPaths;
    this.persistence = persistence;
  }

  /**
   * Gets or creates the room for a document, incrementing its reservation count so it survives
   * until the caller finishes attaching a connection (or calls {@link release}).
   * @param docName - Encoded document identifier (room registry key).
   * @param filePath - Normalized vault-relative file path the document represents.
   * @returns The room, or `null` if it is currently being torn down (caller should retry later).
   */
  public reserve(docName: string, filePath: string): YjsRoom | null {
    const existing = this.rooms.get(docName);

    if (existing) {
      // A new connection during the final flush should reconnect a moment
      // later instead of joining a room generation that is being destroyed.
      if (existing.closingPromise) return null;

      existing.reservations += 1;
      return existing;
    }

    return this.create(docName, filePath);
  }

  /**
   * Detaches a connection from a room and schedules the room for cleanup if it is now unused.
   * @param room - Room the connection belonged to.
   * @param connection - Connection that disconnected.
   */
  public release(room: YjsRoom, connection: WebSocket): void {
    room.releaseConnection(connection);
    this.scheduleCleanup(room);
  }

  /**
   * Invalidates every active room whose file path falls under a deleted path, disconnecting
   * all of their connections so clients stop editing a document that no longer exists.
   * @param targetPath - Normalized vault path (file or folder) that was deleted.
   */
  public invalidateUnderPath(targetPath: string): void {
    for (const room of this.rooms.values()) {
      if (!isSamePathOrChild(targetPath, room.filePath)) continue;

      this.deletedPaths.invalidateDocument(room.doc);

      for (const connection of room.connections.keys()) {
        closeConnection(connection, 1008, "Path deleted");
      }
    }
  }

  /**
   * Creates a new room, registers it, and kicks off asynchronous persistence binding and
   * listener attachment (tracked via `room.ready`). On failure, the room is unregistered,
   * its connections are closed, and its document is destroyed.
   * @param docName - Encoded document identifier (room registry key).
   * @param filePath - Normalized vault-relative file path the document represents.
   * @returns The newly created room (not yet guaranteed to be `ready`).
   */
  private create(docName: string, filePath: string): YjsRoom {
    const room = new YjsRoom(docName, filePath);
    this.rooms.set(docName, room);

    room.ready = (async () => {
      await this.persistence.bindState(docName, room.doc);
      room.attachListeners(() => this.deletedPaths.isDocumentInvalidated(room.doc));
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

  /**
   * If a room has no connections and no pending reservations, asynchronously flushes its
   * state to persistence and destroys it, re-checking those conditions after each await so a
   * new connection arriving mid-flush aborts the teardown. Tracked via `room.closingPromise`
   * to prevent concurrent teardown/reservation races. Errors are logged, not thrown.
   * @param room - Room to consider for cleanup.
   */
  private scheduleCleanup(room: YjsRoom): void {
    if (room.connections.size > 0 || room.reservations > 0 || room.closingPromise) {
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
        console.error(`[Yjs] Could not finalize room ${room.filePath}:`, error);
      })
      .finally(() => {
        room.closingPromise = null;
      });
  }
}
