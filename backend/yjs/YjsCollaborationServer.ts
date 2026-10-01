import { type IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import type * as Y from "yjs";
import { normalizePresenceIdentity } from "./yjsUtils/presence.utils.ts";
import {
  normalizeVaultPath,
  parseDocumentIdentity,
} from "./yjsUtils/vaultPath.utils.ts";
import { closeConnection } from "./yjsUtils/wsTransport.utils.ts";
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
/** Entry point of the Yjs backend for the rest of the server. */
export class YjsCollaborationServer {
  readonly #deletedPaths = new DeletedPathRegistry();
  readonly #persistence = new YjsPersistenceGateway();
  readonly #rooms = new YjsRoomRegistry(this.#deletedPaths, this.#persistence);
  readonly #syncHandler: SyncMessageHandlerFn = syncMessageHandler;

  public setPersistence(adapter: YjsPersistenceAdapter): void {
    this.#persistence.setAdapter(adapter);
  }

  public isPathDeleted(filePath: string): boolean {
    return this.#deletedPaths.isPathDeleted(filePath);
  }

  public isDocumentInvalidated(doc: Y.Doc): boolean {
    return this.#deletedPaths.isDocumentInvalidated(doc);
  }

  public markPathDeleted(targetPath: string): void {
    const normalizedTarget = this.#deletedPaths.markDeleted(targetPath);
    this.#rooms.invalidateUnderPath(normalizedTarget);
  }

  public clearPathDeleted(targetPath: string): void {
    this.#deletedPaths.clearDeleted(targetPath);
  }

  public async deletePersistedStateUnderPath(
    targetPath: string,
  ): Promise<void> {
    await this.#persistence.deleteStateUnderPath(
      normalizeVaultPath(targetPath),
    );
  }

  public async renamePersistedStatePath(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    await this.#persistence.renameStatePath(
      normalizeVaultPath(oldPath),
      normalizeVaultPath(newPath),
    );
  }

  public async setupConnection(
    connection: WebSocket,
    request: IncomingMessage,
    authenticatedUser: YjsAuthenticatedConnection,
  ): Promise<typeof room | undefined> {
    let identity: { docName: string; filePath: string };

    try {
      identity = parseDocumentIdentity(request);
    } catch (error) {
      console.error("[Yjs] Room rejected:", error);
      closeConnection(connection, 1008, "Invalid document path");
      return;
    }

    if (this.#deletedPaths.isPathDeleted(identity.filePath)) {
      closeConnection(connection, 1008, "Document deleted");
      return;
    }

    const room = this.#rooms.reserve(identity.docName, identity.filePath);
    if (!room) {
      closeConnection(connection, 1013, "Room is restarting");
      return;
    }

    const authenticatedPresenceId = normalizePresenceIdentity(
      authenticatedUser.userEmail,
    );

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
      this.#deletedPaths,
      this.#syncHandler,
    );

    connection.on("message", (rawData: RawData, isBinary: boolean) => {
      session.handleRawMessage(rawData, isBinary);
    });

    connection.once("close", () => {
      this.#rooms.release(room, connection);
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
    return room;
  }
}
