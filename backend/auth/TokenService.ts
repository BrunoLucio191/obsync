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

const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const WEB_SOCKET_TICKET_LIFETIME_SECONDS = 30;
const TOKEN_ISSUER = "obsync";
const TOKEN_AUDIENCE = "obsync-api";

type TokenServiceConstructor = {
  secret: string;
  dbService: DBServices;
};

type SessionRecord = {
  readonly userId: number;
  refreshTokenHash: string;
  readonly refreshExpiresAt: number;
};

type AccessAuthorization = {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
  readonly expiresAt: number;
};

type WebSocketTicketRecord = AccessAuthorization & {
  readonly channel: WebSocketChannel;
  readonly ticketExpiresAt: number;
};

export type WebSocketAuthorization = AccessAuthorization;

export class TokenService {
  private readonly secret: string;
  private readonly dbService: DBServices;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly webSocketTickets = new Map<string, WebSocketTicketRecord>();
  private readonly revocationListeners = new Set<(sessionId: string) => void>();

  public constructor({ secret, dbService }: TokenServiceConstructor) {
    if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error(
        "OBSYNC_TOKEN_SECRET deve conter pelo menos 32 bytes aleatórios.",
      );
    }

    this.secret = secret;
    this.dbService = dbService;
  }

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

  public async verifyToken(
    token: string | null | undefined,
  ): Promise<AuthenticatedUser | null> {
    return (await this.authorizeAccessToken(token))?.user ?? null;
  }

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
      !this.safeEqual(
        record.refreshTokenHash,
        this.hashOpaqueToken(refreshToken),
      )
    ) {
      return null;
    }

    const user = await this.dbService.getUserById(record.userId);
    if (!user) {
      this.revokeSessionId(sessionId);
      return null;
    }

    const rotatedRefreshToken = this.createRefreshToken(sessionId);
    record.refreshTokenHash = this.hashOpaqueToken(rotatedRefreshToken);
    return this.buildSession(user, sessionId, rotatedRefreshToken);
  }

  public revokeSession(refreshToken: string | null | undefined): void {
    if (!refreshToken) return;
    const [sessionId, secret, extra] = refreshToken.split(".");
    if (!sessionId || !secret || extra) return;

    const record = this.sessions.get(sessionId);
    if (
      record &&
      this.safeEqual(
        record.refreshTokenHash,
        this.hashOpaqueToken(refreshToken),
      )
    ) {
      this.revokeSessionId(sessionId);
    }
  }

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

  public onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

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

  private issueAccessToken(user: AuthenticatedUser, sessionId: string): string {
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
    } satisfies TokenPayload);
    const signed = `${header}.${payload}`;
    return `${signed}.${this.sign(signed)}`;
  }

  private async authorizeAccessToken(
    token: string | null | undefined,
  ): Promise<AccessAuthorization | null> {
    if (!token) return null;

    const parts = token.split(".");

    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;

    if (!header || !payload || !signature) return null;

    const signed = `${header}.${payload}`;

    if (!this.safeEqual(signature, this.sign(signed))) return null;

    try {
      const headerValue = decode<{ alg?: unknown; typ?: unknown }>(header);
      const value = decode<Partial<TokenPayload>>(payload);
      const now = Math.floor(Date.now() / 1_000);
      const userId = Number(value.sub);

      if (
        headerValue.alg !== "HS256" ||
        headerValue.typ !== "JWT" ||
        value.iss !== TOKEN_ISSUER ||
        value.aud !== TOKEN_AUDIENCE ||
        typeof value.sid !== "string" ||
        typeof value.jti !== "string" ||
        typeof value.iat !== "number" ||
        typeof value.nbf !== "number" ||
        typeof value.exp !== "number" ||
        !Number.isInteger(userId) ||
        userId <= 0 ||
        value.nbf > now ||
        value.exp <= now
      ) {
        return null;
      }

      const session = this.sessions.get(value.sid);

      if (
        !session ||
        session.userId !== userId ||
        session.refreshExpiresAt <= Date.now()
      ) {
        return null;
      }

      const user = await this.dbService.getUserById(userId);

      if (!user) {
        this.revokeSessionId(value.sid);
        return null;
      }

      return {
        user,
        sessionId: value.sid,
        expiresAt: value.exp * 1_000,
      };
    } catch {
      return null;
    }
  }

  private revokeSessionId(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;

    for (const [ticketHash, ticket] of this.webSocketTickets) {
      if (ticket.sessionId === sessionId) {
        this.webSocketTickets.delete(ticketHash);
      }
    }
    for (const listener of this.revocationListeners) listener(sessionId);
  }

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

  private createRefreshToken(sessionId: string): string {
    return `${sessionId}.${this.randomValue()}`;
  }

  private randomValue(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  private hashOpaqueToken(value: string): string {
    return createHmac("sha256", this.secret)
      .update(`opaque:${value}`)
      .digest("base64url");
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
