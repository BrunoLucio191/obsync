import type { DBServices } from "../users/DBServices.ts";
import type { AuthenticatedUser, WebSocketChannel } from "./auth.types.ts";

/** Constructor options for {@link TokenService}. */
export type TokenServiceConstructor = {
  /** HMAC signing secret; must be at least 32 bytes. */
  secret: string;
  dbService: DBServices;
};

/** Decoded header segment of an access token. */
export type TokenHeader = {
  alg: string;
  typ: string;
};

/** Server-side record tracking a login session, keyed by session id, used to validate and rotate refresh tokens. */
export type SessionRecord = {
  readonly userId: number;
  /** HMAC hash of the current refresh token, stored instead of the raw token. */
  refreshTokenHash: string;
  /** Timestamp (ms since epoch) after which the session's refresh token is no longer valid. */
  readonly refreshExpiresAt: number;
};

/** Result of successfully authorizing an access token or ticket: identifies the user, session, and expiry. */
export type AccessAuthorization = {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
  /** Timestamp (ms since epoch) after which this authorization is no longer valid. */
  readonly expiresAt: number;
};

/** Server-side record for a single-use WebSocket connection ticket. */
export type WebSocketTicketRecord = AccessAuthorization & {
  /** The channel this ticket was issued for; must match on consumption. */
  readonly channel: WebSocketChannel;
  /** Timestamp (ms since epoch) after which the ticket itself expires (independent of session expiry). */
  readonly ticketExpiresAt: number;
};

/** Result of successfully consuming a WebSocket ticket, identical shape to {@link AccessAuthorization}. */
export type WebSocketAuthorization = AccessAuthorization;
