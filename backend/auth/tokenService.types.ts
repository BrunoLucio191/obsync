import type { DBServices } from "../users/DBServices.ts";
import type { AuthenticatedUser, WebSocketChannel } from "./auth.types.ts";

export type TokenServiceConstructor = {
  secret: string;
  dbService: DBServices;
};

export type TokenHeader = {
  alg: string;
  typ: string;
};

export type SessionRecord = {
  readonly userId: number;
  refreshTokenHash: string;
  readonly refreshExpiresAt: number;
};

export type AccessAuthorization = {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
  readonly expiresAt: number;
};

export type WebSocketTicketRecord = AccessAuthorization & {
  readonly channel: WebSocketChannel;
  readonly ticketExpiresAt: number;
};

export type WebSocketAuthorization = AccessAuthorization;
