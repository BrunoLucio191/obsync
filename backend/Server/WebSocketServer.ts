import { type IncomingMessage, type Server } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import { YjsPersistence } from "./YjsPersistence.ts";
import type { YjsCollaborationServer } from "../yjs/YjsCollaborationServer.ts";
import { MAX_WS_MESSAGE_BYTES } from "../yjs/yjs.const.ts";
import { vaultEvents, type VaultChange } from "../syncEvents.ts";
import { dbEvents } from "../users/DBEvents.ts";
import type { TokenService } from "../auth/TokenService.ts";
import type { WebSocketChannel } from "../auth/auth.types.ts";
import { systemPaths } from "../paths.ts";
import { type WebSocketAuthorization } from "../auth/tokenService.types.ts";
const HEARTBEAT_INTERVAL_MS = 30_000;
const TICKET_PROTOCOL_PREFIX = "obsync-ticket.";

/**
 * Manages the two ticket-authenticated WebSocket endpoints on top of the shared HTTP server:
 * `/system` (a read-only broadcast channel for vault change notifications) and `/yjs`
 * (bidirectional real-time collaboration traffic, delegated to {@link YjsCollaborationServer}).
 * Handles ticket-based authentication on upgrade, heartbeats/dead-connection cleanup, and
 * forcibly closing connections when a session is revoked or a user's authorization changes.
 */
export class WebSocketServer {
  public readonly wssSystem: WsServer;
  public readonly wssYjs: WsServer;
  /** Emitter for cross-cutting DB events (currently used for authorization-changed notifications). */
  private readonly event;
  private readonly tokenService: TokenService;
  private readonly collaborationServer: YjsCollaborationServer;
  /** Maps each live socket to the authorization it was upgraded with. */
  private readonly authenticatedConnections = new Map<WebSocket, WebSocketAuthorization>();
  /** Tracks which sockets have responded to the most recent heartbeat ping. */
  private readonly aliveConnections = new WeakSet<WebSocket>();
  private readonly unsubscribeAuthorizationChanges: () => void;
  private readonly unsubscribeSessionRevocations: () => void;
  private readonly requireTls: boolean;
  private readonly trustProxy: boolean;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Sets up both WebSocket servers (in `noServer` mode) and hooks the shared HTTP server's
   * `upgrade` event to route requests to the right one based on ticket + path. Does not start
   * accepting `connection` events until {@link initializeWebSockets} is called.
   * @param server - The shared HTTP server to attach the `upgrade` handler to.
   * @param tokenService - Used to consume WebSocket tickets and listen for session revocations.
   * @param requireTls - When `true`, rejects non-secure upgrade requests.
   * @param trustProxy - When `true`, trusts `X-Forwarded-Proto` to determine if a proxied request is secure.
   * @param collaborationServer - Handles the actual Yjs protocol traffic for `/yjs` connections.
   */
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

    this.unsubscribeAuthorizationChanges = this.event.onAuthorizationChanged((userId) =>
      this.closeUserConnections(userId),
    );
    this.unsubscribeSessionRevocations = tokenService.onSessionRevoked((sessionId) =>
      this.closeSessionConnections(sessionId),
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

  /**
   * Handles a raw HTTP `upgrade` request: enforces TLS if required, picks the target channel
   * from the URL path, validates the ticket presented via the `Sec-WebSocket-Protocol` header,
   * and completes the upgrade on the matching `WsServer` if authorization succeeds.
   * @param request - The incoming upgrade request.
   * @param socket - The raw duplex socket to upgrade (or reject and destroy).
   * @param head - The first packet of the upgraded stream, passed through to `handleUpgrade`.
   */
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

    const channel: WebSocketChannel = url.pathname === "/system" ? "system" : "yjs";
    const ticket = this.readTicketProtocol(request);
    const authorization = await this.tokenService.consumeWebSocketTicket(ticket, channel);
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

  /**
   * Wires up the actual `connection` handlers: binds Yjs persistence, routes `/yjs` connections
   * into {@link YjsCollaborationServer.setupConnection}, makes `/system` connections receive-only
   * (closing any socket that sends a message), broadcasts vault changes to `/system` clients, and
   * starts the heartbeat loop. Must be called once after construction, before the server accepts traffic.
   */
  public initializeWebSockets(): void {
    const yjsPersistence = new YjsPersistence(
      systemPaths.vault,
      systemPaths.yjsState,
      this.collaborationServer,
    );

    this.collaborationServer.setPersistence({
      bindState: (docName, ydoc) => yjsPersistence.bindState(docName, ydoc),
      writeState: (docName, ydoc) => yjsPersistence.writeState(docName, ydoc),
      destroyState: (docName, ydoc) => yjsPersistence.destroyState(docName, ydoc),
      deleteStateUnderPath: (targetPath) => yjsPersistence.deleteStateUnderPath(targetPath),
      renameStatePath: (oldPath, newPath) => yjsPersistence.renameStatePath(oldPath, newPath),
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

  /** Closes every authenticated connection belonging to a given user (e.g. after their role/status changed). */
  private closeUserConnections(userId: number): void {
    for (const [connection, authorization] of this.authenticatedConnections) {
      if (authorization.user.id !== userId) continue;
      this.closeAuthorizationChangedConnection(connection);
    }
  }

  /** Closes every authenticated connection tied to a given session id (e.g. after logout or token revocation). */
  private closeSessionConnections(sessionId: string): void {
    for (const [connection, authorization] of this.authenticatedConnections) {
      if (authorization.sessionId !== sessionId) continue;
      this.closeAuthorizationChangedConnection(connection);
    }
  }

  /** Closes (or terminates, if still connecting) a socket whose authorization is no longer valid, using close code 4003. */
  private closeAuthorizationChangedConnection(connection: WebSocket): void {
    if (connection.readyState === WebSocket.OPEN) {
      connection.close(4003, "Authorization changed");
    } else if (connection.readyState === WebSocket.CONNECTING) {
      connection.terminate();
    }
  }

  /**
   * Extracts the WebSocket ticket embedded in the `Sec-WebSocket-Protocol` header (as
   * `"obsync-ticket.<ticket>"`), since browsers can't send custom headers during a WS handshake.
   * @param request - The upgrade request to read the header from.
   * @returns The extracted ticket if present and well-formed (43 base64url characters), otherwise `null`.
   */
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

  /** Determines whether an upgrade request arrived over a secure (TLS) connection, trusting `X-Forwarded-Proto` only when `trustProxy` is enabled. */
  private isSecureRequest(request: IncomingMessage): boolean {
    const encrypted = (request.socket as { encrypted?: boolean }).encrypted;
    if (encrypted) return true;
    if (!this.trustProxy) return false;

    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const value = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol;
    return value?.split(",")[0]?.trim().toLowerCase() === "https";
  }

  /** Marks a new connection as alive and keeps marking it alive on every `pong` reply. */
  private registerHeartbeat(webSocket: WebSocket): void {
    this.aliveConnections.add(webSocket);
    webSocket.on("pong", () => this.aliveConnections.add(webSocket));
  }

  /** Starts the periodic ping loop that detects and terminates dead connections. Idempotent. */
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

  /**
   * One heartbeat tick for a single `WsServer`: terminates any client that didn't respond to the
   * previous ping, then pings all remaining clients.
   * @param server - The WebSocket server whose clients should be pinged.
   */
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
