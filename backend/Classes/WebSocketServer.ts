import { type IncomingMessage, type Server } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import { YjsPersistence } from "./YjsPersistence.ts";
import type { YjsCollaborationServer } from "../yjs/YjsCollaborationServer.ts";
import { MAX_WS_MESSAGE_BYTES } from "../yjs/yjs.cons.ts";
import { vaultEvents, type VaultChange } from "../syncEvents.ts";
import { dbEvents } from "../users/DBEvents.ts";
import type { TokenService } from "../auth/TokenService.ts";
import type { WebSocketChannel } from "../auth/auth.types.ts";
import { systemPaths } from "../paths.ts";
import { type WebSocketAuthorization } from "../auth/tokenService.types.ts";
const HEARTBEAT_INTERVAL_MS = 30_000;
const TICKET_PROTOCOL_PREFIX = "obsync-ticket.";

export class WebSocketServer {
  public readonly wssSystem: WsServer;
  public readonly wssYjs: WsServer;
  private readonly event;
  private readonly tokenService: TokenService;
  private readonly collaborationServer: YjsCollaborationServer;
  private readonly authenticatedConnections = new Map<
    WebSocket,
    WebSocketAuthorization
  >();
  private readonly aliveConnections = new WeakSet<WebSocket>();
  private readonly unsubscribeAuthorizationChanges: () => void;
  private readonly unsubscribeSessionRevocations: () => void;
  private readonly requireTls: boolean;
  private readonly trustProxy: boolean;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public constructor(
    server: Server,
    tokenService: TokenService,
    requireTls: boolean,
    trustProxy: boolean,
    collaborationServer: YjsCollaborationServer,
  ) {
    this.collaborationServer = collaborationServer;
    this.wssSystem = new WsServer({
      noServer: true,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.wssYjs = new WsServer({
      noServer: true,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.event = dbEvents();
    this.tokenService = tokenService;
    this.requireTls = requireTls;
    this.trustProxy = trustProxy;

    this.unsubscribeAuthorizationChanges = this.event.onAuthorizationChanged(
      (userId) => this.closeUserConnections(userId),
    );
    this.unsubscribeSessionRevocations = tokenService.onSessionRevoked(
      (sessionId) => this.closeSessionConnections(sessionId),
    );

    server.on("upgrade", (request, socket, head) => {
      try {
        this.handleUpgrade(request, socket, head);
      } catch (err) {
        console.error(err);
      }
    });

    server.once("close", () => {
      this.stopHeartbeat();
      this.unsubscribeAuthorizationChanges();
      this.unsubscribeSessionRevocations();
    });
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (this.requireTls && !this.isSecureRequest(request)) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      socket.destroy();
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const channel: WebSocketChannel =
      url.pathname === "/system" ? "system" : "yjs";
    const ticket = this.readTicketProtocol(request);
    const authorization = await this.tokenService.consumeWebSocketTicket(
      ticket,
      channel,
    );
    if (!authorization) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const targetServer = channel === "system" ? this.wssSystem : this.wssYjs;

    targetServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.authenticatedConnections.set(webSocket, authorization);
      const expirationTimer = setTimeout(
        () => {
          webSocket.close(4003, "Access token expired");
        },
        Math.max(0, authorization.expiresAt - Date.now()),
      );
      expirationTimer.unref();
      webSocket.once("close", () => {
        clearTimeout(expirationTimer);
        this.authenticatedConnections.delete(webSocket);
      });

      targetServer.emit("connection", webSocket, request);
    });
  }

  public initializeWebSockets(): void {
    const yjsPersistence = new YjsPersistence(
      systemPaths.vault,
      systemPaths.yjsState,
      this.collaborationServer,
    );

    this.collaborationServer.setPersistence({
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
      const authorization = this.authenticatedConnections.get(webSocket);
      if (!authorization) {
        webSocket.close(1008, "Missing authenticated user");
        return;
      }
      const { user } = authorization;

      void this.collaborationServer
        .setupConnection(webSocket, request, {
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          userRole: user.role,
        })
        .catch((error: unknown) => {
          console.error("[Yjs] Unexpected connection failure:", error);
          webSocket.close(1011, "Internal Yjs error");
        });
    });

    this.wssSystem.on("connection", (webSocket) => {
      this.registerHeartbeat(webSocket);
      const authorization = this.authenticatedConnections.get(webSocket);
      if (!authorization) {
        webSocket.close(1008, "Missing authenticated user");
        return;
      }
      const { user } = authorization;

      webSocket.on("message", () => {
        console.warn("[Audit] Mutation message refused on the /system channel", {
          userId: user.id,
          role: user.role,
          operation: "system-message",
          timestamp: new Date().toISOString(),
          allowed: false,
        });
        webSocket.close(1008, "System channel is receive-only");
      });
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
    for (const [connection, authorization] of this.authenticatedConnections) {
      if (authorization.user.id !== userId) continue;
      this.closeAuthorizationChangedConnection(connection);
    }
  }

  private closeSessionConnections(sessionId: string): void {
    for (const [connection, authorization] of this.authenticatedConnections) {
      if (authorization.sessionId !== sessionId) continue;
      this.closeAuthorizationChangedConnection(connection);
    }
  }

  private closeAuthorizationChangedConnection(connection: WebSocket): void {
    if (connection.readyState === WebSocket.OPEN) {
      connection.close(4003, "Authorization changed");
    } else if (connection.readyState === WebSocket.CONNECTING) {
      connection.terminate();
    }
  }

  private readTicketProtocol(request: IncomingMessage): string | null {
    const header = request.headers["sec-websocket-protocol"];
    const values = Array.isArray(header) ? header : [header];

    for (const value of values) {
      if (!value) continue;
      for (const protocol of value.split(",")) {
        const normalized = protocol.trim();
        if (!normalized.startsWith(TICKET_PROTOCOL_PREFIX)) continue;

        const ticket = normalized.slice(TICKET_PROTOCOL_PREFIX.length);
        if (/^[A-Za-z0-9_-]{43}$/.test(ticket)) return ticket;
      }
    }

    return null;
  }

  private isSecureRequest(request: IncomingMessage): boolean {
    const encrypted = (request.socket as { encrypted?: boolean }).encrypted;
    if (encrypted) return true;
    if (!this.trustProxy) return false;

    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const value = Array.isArray(forwardedProtocol)
      ? forwardedProtocol[0]
      : forwardedProtocol;
    return value?.split(",")[0]?.trim().toLowerCase() === "https";
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

  private pingServerClients(server: WsServer): void {
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
