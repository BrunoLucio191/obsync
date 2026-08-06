import { type IncomingMessage, type Server } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { type AuthenticatedUser } from "../auth/auth.types.ts";
import { YjsPersistence } from "./YjsPersistence.ts";
import {
  MAX_WS_MESSAGE_BYTES,
  setupWSConnection,
  setPersistence,
} from "../yjsUtils.ts";
import { vaultEvents, type VaultChange } from "../syncEvents.ts";
import { FileManager } from "./FileManager.ts";
import { dbEvents } from "../users/DBEvents.ts";
import type { TokenService } from "../auth/TokenService.ts";
import { systemPaths } from "../paths.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

export class WebSHocket {
  public readonly wssSystem: WebSocketServer;
  public readonly wssYjs: WebSocketServer;
  private readonly event;
  private readonly tokenService: TokenService;
  private readonly authenticatedUsers = new Map<WebSocket, AuthenticatedUser>();
  private readonly aliveConnections = new WeakSet<WebSocket>();
  private readonly unsubscribeAuthorizationChanges: () => void;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public constructor(server: Server, tokenService: TokenService) {
    this.wssSystem = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.wssYjs = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.event = dbEvents();
    this.tokenService = tokenService;

    this.unsubscribeAuthorizationChanges = this.event.onAuthorizationChanged(
      (userId) => this.closeUserConnections(userId),
    );

    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    server.once("close", () => {
      this.stopHeartbeat();
      this.unsubscribeAuthorizationChanges();
    });
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const user = await this.tokenService.verifyToken(
      url.searchParams.get("token"),
    );
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const channel = url.pathname === "/system" ? "system" : "yjs";
    const targetServer = channel === "system" ? this.wssSystem : this.wssYjs;

    targetServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.authenticatedUsers.set(webSocket, user);
      webSocket.once("close", () => this.authenticatedUsers.delete(webSocket));

      targetServer.emit("connection", webSocket, request);
    });
  }

  public initializeWebSockets(): void {
    const yjsPersistence = new YjsPersistence(systemPaths.vault);

    setPersistence({
      bindState: (docName, ydoc) => yjsPersistence.bindState(docName, ydoc),
      writeState: (docName, ydoc) => yjsPersistence.writeState(docName, ydoc),
      destroyState: (docName, ydoc) =>
        yjsPersistence.destroyState(docName, ydoc),
      deleteStateUnderPath: (targetPath) =>
        yjsPersistence.deleteStateUnderPath(targetPath),
      renameStatePath: (oldPath, newPath) =>
        yjsPersistence.renameStatePath(oldPath, newPath),
    });

    this.wssYjs.on("connection", (webSocket, request) => {
      this.registerHeartbeat(webSocket);
      const user = this.authenticatedUsers.get(webSocket);
      if (!user) {
        webSocket.close(1008, "Missing authenticated user");
        return;
      }

      void setupWSConnection(webSocket, request, {
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
      }).catch((error: unknown) => {
        console.error("[Yjs] Falha inesperada na conexão:", error);
        webSocket.close(1011, "Internal Yjs error");
      });
    });

    this.wssSystem.on("connection", (webSocket) => {
      this.registerHeartbeat(webSocket);
      const user = this.authenticatedUsers.get(webSocket);
      if (!user) {
        webSocket.close(1008, "Missing authenticated user");
        return;
      }

      webSocket.on("message", () => {
        console.warn("[Audit] Mensagem de mutação recusada no canal /system", {
          userId: user.id,
          role: user.role,
          operation: "system-message",
          timestamp: new Date().toISOString(),
          allowed: false,
        });
        webSocket.close(1008, "System channel is receive-only");
      });

      webSocket.once("close", (code, reason) => {});
    });

    vaultEvents.on("change", (change: VaultChange) => {
      const message = JSON.stringify(change);
      for (const client of this.wssSystem.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      }
    });

    this.startHeartbeat();
  }

  private closeUserConnections(userId: number): void {
    for (const [connection, user] of this.authenticatedUsers) {
      if (user.id !== userId) continue;
      if (connection.readyState === WebSocket.OPEN) {
        connection.close(4003, "Authorization changed");
      } else if (connection.readyState === WebSocket.CONNECTING) {
        connection.terminate();
      }
    }
  }

  private registerHeartbeat(webSocket: WebSocket): void {
    this.aliveConnections.add(webSocket);
    webSocket.on("pong", () => this.aliveConnections.add(webSocket));
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.pingServerClients(this.wssYjs);
      this.pingServerClients(this.wssSystem);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private pingServerClients(server: WebSocketServer): void {
    for (const client of server.clients) {
      if (!this.aliveConnections.has(client)) {
        client.terminate();
        continue;
      }

      this.aliveConnections.delete(client);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }
}
