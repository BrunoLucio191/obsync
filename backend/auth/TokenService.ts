import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthenticatedUser,
  AuthSession,
  TokenPayload,
  WebSocketChannel,
  WebSocketTicket,
} from "./auth.types.ts";
import { decode, encode } from "./encoding.ts";
import type { DBServices } from "../users/DBServices.ts";
import type {
  SessionRecord,
  WebSocketTicketRecord,
  TokenServiceConstructor,
  WebSocketAuthorization,
  AccessAuthorization,
  TokenHeader,
} from "./tokenService.types.ts";

const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const WEB_SOCKET_TICKET_LIFETIME_SECONDS = 30;
const TOKEN_ISSUER = "obsync";
const TOKEN_AUDIENCE = "obsync-api";

/**
 * Issues and validates the app's authentication tokens: short-lived signed access tokens
 * (a hand-rolled JWT-like format), long-lived opaque refresh tokens, and single-use WebSocket
 * connection tickets. All session and ticket state is kept in memory (not persisted), so it is
 * lost on process restart.
 */
export class TokenService {
  private readonly secret: string;
  private readonly dbService: DBServices;
  /** Active login sessions, keyed by session id. */
  private readonly sessions = new Map<string, SessionRecord>();
  /** Pending single-use WebSocket tickets, keyed by the HMAC hash of the ticket value. */
  private readonly webSocketTickets = new Map<string, WebSocketTicketRecord>();
  /** Callbacks notified whenever a session is revoked (e.g. so open WebSocket connections can be closed). */
  private readonly revocationListeners = new Set<(sessionId: string) => void>();

  /**
   * @param options.secret - HMAC signing secret; must be at least 32 bytes long.
   * @param options.dbService - Service used to re-fetch user records when validating tokens/sessions.
   * @throws If `secret` is missing or shorter than 32 bytes.
   */
  public constructor({ secret, dbService }: TokenServiceConstructor) {
    if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("OBSYNC_TOKEN_SECRET must contain at least 32 random bytes.");
    }

    this.secret = secret;
    this.dbService = dbService;
  }

  /**
   * Creates a brand-new session (and its refresh token) for an already-authenticated user, e.g. right after login.
   * @param user - The user to create a session for.
   * @returns A fresh {@link AuthSession} containing an access token and refresh token.
   */
  public sessionFor(user: AuthenticatedUser): AuthSession {
    this.removeExpiredState();
    const sessionId = this.randomValue();
    const refreshToken = this.createRefreshToken(sessionId);

    this.sessions.set(sessionId, {
      userId: user.id,
      refreshTokenHash: this.hashOpaqueToken(refreshToken),
      refreshExpiresAt: Date.now() + REFRESH_TOKEN_LIFETIME_MS,
    });

    return this.buildSession(user, sessionId, refreshToken);
  }

  /**
   * Validates an access token (signature, claims, expiry, and backing session) and resolves the current user.
   * @param token - The bearer access token to verify, or `null`/`undefined` if none was supplied.
   * @returns The {@link AuthenticatedUser} the token belongs to, or `null` if the token is missing/invalid/expired.
   */
  public async verifyToken(token: string | null | undefined): Promise<AuthenticatedUser | null> {
    return (await this.authorizeAccessToken(token))?.user ?? null;
  }

  /**
   * Exchanges a valid refresh token for a brand-new session, rotating the refresh token in the process.
   * @param refreshToken - The opaque refresh token to redeem, or `null`/`undefined` if none was supplied.
   * @returns A new {@link AuthSession}, or `null` if the refresh token is missing/invalid/expired or its user no longer exists.
   */
  public async refreshSession(
    refreshToken: string | null | undefined,
  ): Promise<AuthSession | null> {
    if (!refreshToken) return null;
    this.removeExpiredState();

    const [sessionId, secret, extra] = refreshToken.split(".");

    if (!sessionId || !secret || extra) return null;

    const record = this.sessions.get(sessionId);
    if (
      !record ||
      record.refreshExpiresAt <= Date.now() ||
      !this.safeEqual(record.refreshTokenHash, this.hashOpaqueToken(refreshToken))
    ) {
      return null;
    }

    //user need to exist in the db
    const user = await this.dbService.getUserById(record.userId);
    if (!user) {
      this.revokeSessionId(sessionId);

      return null;
    }

    const rotatedRefreshToken = this.createRefreshToken(sessionId);
    record.refreshTokenHash = this.hashOpaqueToken(rotatedRefreshToken);

    return this.buildSession(user, sessionId, rotatedRefreshToken);
  }

  /**
   * Revokes the session identified by a refresh token (e.g. on logout), invalidating its access tokens and tickets.
   * @param refreshToken - The refresh token identifying the session to revoke, or `null`/`undefined` to no-op.
   */
  public revokeSession(refreshToken: string | null | undefined): void {
    if (!refreshToken) return;

    const [sessionId, secret, extra] = refreshToken.split(".");
    if (!sessionId || !secret || extra) return;

    const record = this.sessions.get(sessionId);
    if (record && this.safeEqual(record.refreshTokenHash, this.hashOpaqueToken(refreshToken))) {
      this.revokeSessionId(sessionId);
    }
  }

  /**
   * Issues a short-lived, single-use ticket that a client can use to authenticate a WebSocket upgrade
   * (WebSocket handshakes cannot carry an `Authorization` header, hence this ticket indirection).
   * @param accessToken - A currently-valid access token identifying the requesting user.
   * @param channel - The WebSocket channel (`"system"` or `"yjs"`) the ticket will be valid for.
   * @returns A new {@link WebSocketTicket}, or `null` if the access token is invalid.
   */
  public async issueWebSocketTicket(
    accessToken: string | null | undefined,
    channel: WebSocketChannel,
  ): Promise<WebSocketTicket | null> {
    const authorization = await this.authorizeAccessToken(accessToken);
    if (!authorization) return null;

    this.removeExpiredState();
    const ticket = this.randomValue();
    this.webSocketTickets.set(this.hashOpaqueToken(ticket), {
      ...authorization,
      channel,
      ticketExpiresAt: Date.now() + WEB_SOCKET_TICKET_LIFETIME_SECONDS * 1_000,
    });

    return { ticket, expiresIn: WEB_SOCKET_TICKET_LIFETIME_SECONDS };
  }

  /**
   * Redeems a WebSocket ticket exactly once, validating it against the requested channel, its own
   * expiry, and the backing session's expiry.
   * @param ticket - The ticket value presented by the client during the WebSocket upgrade.
   * @param channel - The channel the connection is being made on; must match the ticket's issued channel.
   * @returns The resolved {@link WebSocketAuthorization}, or `null` if the ticket is missing/invalid/expired/wrong-channel.
   */
  public async consumeWebSocketTicket(
    ticket: string | null | undefined,
    channel: WebSocketChannel,
  ): Promise<WebSocketAuthorization | null> {
    if (!ticket) return null;
    this.removeExpiredState();

    const ticketHash = this.hashOpaqueToken(ticket);
    const record = this.webSocketTickets.get(ticketHash);
    this.webSocketTickets.delete(ticketHash);

    if (
      !record ||
      record.channel !== channel ||
      record.ticketExpiresAt <= Date.now() ||
      record.expiresAt <= Date.now() ||
      !this.sessions.has(record.sessionId)
    ) {
      return null;
    }

    const user = await this.dbService.getUserById(record.user.id);
    if (!user) {
      this.revokeSessionId(record.sessionId);
      return null;
    }

    return {
      user,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Subscribes to session revocation events (e.g. so a WebSocket server can close connections for a revoked session).
   * @param listener - Called with the session id whenever a session is revoked.
   * @returns An unsubscribe function that removes the listener.
   */
  public onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  /** Assembles the client-facing {@link AuthSession} object: a fresh access token plus the given refresh token. */
  private buildSession(
    user: AuthenticatedUser,
    sessionId: string,
    refreshToken: string,
  ): AuthSession {
    return {
      token: this.issueAccessToken(user, sessionId),
      refreshToken,
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      user,
    };
  }

  /** Builds and signs a new access token (header.payload.signature) for the given user and session. */
  private issueAccessToken(user: AuthenticatedUser, sessionId: string): string {
    //transform in seconds;
    const now = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      sub: String(user.id),
      sid: sessionId,
      jti: this.randomValue(16),
      iat: now,
      nbf: now,
      exp: now + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
    const signed = `${header}.${payload}`;
    return `${signed}.${this.sign(signed)}`;
  }

  /**
   * Full validation pipeline for an access token: signature check, structural/claim checks,
   * expiry checks, and cross-referencing the live session and current user record.
   */
  private async authorizeAccessToken(
    token: string | null | undefined,
  ): Promise<AccessAuthorization | null> {
    if (!token) return null;

    const tokenParts = token.split(".");

    if (tokenParts.length !== 3) return null;

    const [header, payload, signature] = tokenParts;

    if (!header || !payload || !signature) return null;

    const signedForVerication = `${header}.${payload}`;
    if (!this.safeEqual(signature, this.sign(signedForVerication))) return null;

    try {
      const headerValue = decode<TokenHeader>(header);
      const payloadValue = decode<Partial<TokenPayload>>(payload);
      const now = Math.floor(Date.now() / 1_000);
      const userId = Number(payloadValue.sub);

      if (
        headerValue.alg !== "HS256" ||
        headerValue.typ !== "JWT" ||
        payloadValue.iss !== TOKEN_ISSUER ||
        payloadValue.aud !== TOKEN_AUDIENCE ||
        typeof payloadValue.sid !== "string" ||
        typeof payloadValue.jti !== "string" ||
        typeof payloadValue.iat !== "number" ||
        typeof payloadValue.nbf !== "number" ||
        typeof payloadValue.exp !== "number" ||
        !Number.isInteger(userId) ||
        userId <= 0 ||
        payloadValue.nbf > now ||
        payloadValue.exp <= now
      ) {
        return null;
      }

      const session = this.sessions.get(payloadValue.sid);
      if (!session || session.userId !== userId || session.refreshExpiresAt <= Date.now()) {
        return null;
      }

      const user = await this.dbService.getUserById(userId);
      if (!user) {
        this.revokeSessionId(payloadValue.sid);
        return null;
      }

      return {
        user,
        sessionId: payloadValue.sid,
        expiresAt: payloadValue.exp * 1_000,
      };
    } catch {
      return null;
    }
  }

  /** Removes a session and any WebSocket tickets tied to it, then notifies revocation listeners. */
  private revokeSessionId(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;

    for (const [ticketHash, ticket] of this.webSocketTickets) {
      if (ticket.sessionId === sessionId) {
        this.webSocketTickets.delete(ticketHash);
      }
    }
    for (const listener of this.revocationListeners) {
      listener(sessionId);
    }
  }

  /** Sweeps expired sessions (revoking them) and expired WebSocket tickets. Called lazily before mutating state. */
  private removeExpiredState(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.refreshExpiresAt <= now) this.revokeSessionId(sessionId);
    }
    for (const [ticketHash, ticket] of this.webSocketTickets) {
      if (ticket.ticketExpiresAt <= now) {
        this.webSocketTickets.delete(ticketHash);
      }
    }
  }

  /** Builds a new opaque refresh token string in the form `"<sessionId>.<random>"`. */
  private createRefreshToken(sessionId: string): string {
    return `${sessionId}.${this.randomValue()}`;
  }

  /**
   * Generates a cryptographically random, base64url-encoded value.
   * @param bytes - Number of random bytes to generate (default 32).
   * @returns The random value as a base64url string.
   */
  private randomValue(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  /** Computes an HMAC-SHA256 signature (base64url) over a value, using the service secret. */
  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  /** Hashes an opaque token (e.g. a refresh token or ticket) so only its HMAC is kept in memory, not the raw value. */
  private hashOpaqueToken(value: string): string {
    return createHmac("sha256", this.secret).update(`opaque:${value}`).digest("base64url");
  }

  /** Constant-time string equality check, used to compare secrets/hashes without leaking timing information. */
  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
