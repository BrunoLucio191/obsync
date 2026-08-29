import { type IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import type * as Y from "yjs";
import { normalizePresenceIdentity } from "./yjsUtils/presence.utils.ts";
import { normalizeVaultPath, parseDocumentIdentity } from "./yjsUtils/vaultPath.utils.ts";
import { closeConnection } from "./yjsUtils/wsTransport.utils.ts";
import { AwarenessOwnershipGuard } from "./AwarenessOwnershipGuard.ts";
import { DeletedPathRegistry } from "./DeletedPathRegistry.ts";
import type { SyncMessageHandlerFn } from "./SyncMessageHandler.ts";
import { YjsConnectionSession } from "./YjsConnectionSession.ts";
import { YjsPersistenceGateway } from "./YjsPersistenceGateway.ts";
import { YjsRoomRegistry } from "./yjsRooms/YjsRoomRegistry.ts";
import type {
  YjsAuthenticatedConnection,
  YjsConnectionState,
  YjsPersistenceAdapter,
} from "./yjs.types.ts";
import { syncMessageHandler } from "./SyncMessageHandler.ts";

/**
 * Top-level facade for the Yjs real-time collaboration backend. Wires together the room
 * registry, persistence gateway, and per-message handlers (sync/awareness), and exposes the
 * operations the rest of the server needs: configuring persistence, reacting to vault file
 * events (delete/rename), and accepting new authenticated WebSocket connections.
 */
export class YjsCollaborationServer {
  private readonly deletedPaths = new DeletedPathRegistry();
  private readonly persistence = new YjsPersistenceGateway();
  private readonly rooms = new YjsRoomRegistry(this.deletedPaths, this.persistence);
  private readonly syncHandler: SyncMessageHandlerFn = syncMessageHandler;
  private readonly awarenessGuard = new AwarenessOwnershipGuard();

  /**
   * Configures the storage backend used to persist Yjs documents.
   * @param adapter - Concrete persistence implementation to use.
   */
  public setPersistence(adapter: YjsPersistenceAdapter): void {
    this.persistence.setAdapter(adapter);
  }

  /**
   * Checks whether a vault path is currently marked as deleted.
   * @param filePath - Vault path to check.
   * @returns `true` if the path (or an ancestor folder) was marked deleted.
   */
  public isPathDeleted(filePath: string): boolean {
    return this.deletedPaths.isPathDeleted(filePath);
  }

  /**
   * Checks whether a specific in-memory Yjs document was invalidated by a path deletion.
   * @param doc - Yjs document instance to check.
   * @returns `true` if the document was invalidated.
   */
  public isDocumentInvalidated(doc: Y.Doc): boolean {
    return this.deletedPaths.isDocumentInvalidated(doc);
  }

  /**
   * Records that a vault path was deleted and immediately disconnects/invalidates any active
   * room under it.
   * @param targetPath - Vault path that was deleted.
   */
  public markPathDeleted(targetPath: string): void {
    const normalizedTarget = this.deletedPaths.markDeleted(targetPath);
    this.rooms.invalidateUnderPath(normalizedTarget);
  }

  /**
   * Clears a previously recorded deletion for a vault path (e.g. it was recreated).
   * @param targetPath - Vault path that should no longer be considered deleted.
   */
  public clearPathDeleted(targetPath: string): void {
    this.deletedPaths.clearDeleted(targetPath);
  }

  /**
   * Deletes persisted Yjs state for a vault path and everything nested under it.
   * @param targetPath - Vault path (not required to be pre-normalized) that was deleted.
   */
  public async deletePersistedStateUnderPath(targetPath: string): Promise<void> {
    await this.persistence.deleteStateUnderPath(normalizeVaultPath(targetPath));
  }

  /**
   * Moves persisted Yjs state from one vault path to another.
   * @param oldPath - Vault path being moved from (not required to be pre-normalized).
   * @param newPath - Vault path being moved to (not required to be pre-normalized).
   */
  public async renamePersistedStatePath(oldPath: string, newPath: string): Promise<void> {
    await this.persistence.renameStatePath(
      normalizeVaultPath(oldPath),
      normalizeVaultPath(newPath),
    );
  }

  /**
   * Handles a newly upgraded, already-authenticated WebSocket connection: resolves which
   * document it targets, rejects it if the path is invalid/deleted or the room is restarting,
   * reserves/joins the room, and wires up message/close/error listeners before sending the
   * initial sync.
   * @param connection - The freshly upgraded WebSocket connection.
   * @param request - The original HTTP upgrade request, whose URL encodes the target document.
   * @param authenticatedUser - Identity resolved during the WebSocket handshake/auth step.
   */
  public async setupConnection(
    connection: WebSocket,
    request: IncomingMessage,
    authenticatedUser: YjsAuthenticatedConnection,
  ): Promise<void> {
    let identity: { docName: string; filePath: string };

    try {
      identity = parseDocumentIdentity(request);
    } catch (error) {
      console.error("[Yjs] Room rejected:", error);
      closeConnection(connection, 1008, "Invalid document path");
      return;
    }

    if (this.deletedPaths.isPathDeleted(identity.filePath)) {
      closeConnection(connection, 1008, "Document deleted");
      return;
    }

    const room = this.rooms.reserve(identity.docName, identity.filePath);
    if (!room) {
      closeConnection(connection, 1013, "Room is restarting");
      return;
    }

    const authenticatedPresenceId = normalizePresenceIdentity(authenticatedUser.userEmail);

    if (!authenticatedPresenceId) {
      closeConnection(connection, 1008, "Authenticated user has no email");
      return;
    }

    const connectionState: YjsConnectionState = {
      controlledAwarenessIds: new Set(),
      authenticatedPresenceId,
      userId: authenticatedUser.userId,
      userRole: authenticatedUser.userRole,
      canWriteGlobal: authenticatedUser.userRole === "admin",
      closed: false,
    };

    room.connections.set(connection, connectionState);
    room.reservations -= 1;
    connection.binaryType = "arraybuffer";
    const session = new YjsConnectionSession(
      room,
      connection,
      connectionState,
      this.deletedPaths,
      this.syncHandler,
      this.awarenessGuard,
    );

    connection.on("message", (rawData: RawData, isBinary: boolean) => {
      session.handleRawMessage(rawData, isBinary);
    });

    connection.once("close", () => {
      this.rooms.release(room, connection);
    });

    connection.once("error", (error: Error) => {
      console.error(`[Yjs] Error in room ${room.filePath}:`, error);
    });

    try {
      await room.ready;

      if (!connectionState.closed) {
        room.sendInitialSync(connection);
      }
    } catch (error) {
      console.error(`[Yjs] Failed to initialize ${room.filePath}:`, error);
      closeConnection(connection, 1011, "Document initialization failed");
    }
  }
}
