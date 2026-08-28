/** The two roles a user account can have. Admins can manage users and perform global vault mutations; regular users cannot. */
export type UserRole = "admin" | "user";

/** A user record as exposed to the rest of the app once authenticated (password hash stripped). */
export type AuthenticatedUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
};

/** The payload returned to a client after a successful login or token refresh. */
export type AuthSession = {
  /** Short-lived access token (JWT-like) used to authenticate API/WebSocket requests. */
  token: string;
  /** Long-lived opaque token used to obtain a new session via {@link TokenService.refreshSession}. */
  refreshToken: string;
  /** Number of seconds until `token` expires. */
  expiresIn: number;
  user: AuthenticatedUser;
};

/** The two WebSocket channels a client can request a connection ticket for. */
export type WebSocketChannel = "system" | "yjs";

/** A short-lived, single-use ticket that authorizes a WebSocket upgrade for a given channel. */
export type WebSocketTicket = {
  ticket: string;
  expiresIn: number;
};

/** Outcome of attempting to create a new user account. */
export type CreateUserResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "email_exists" | "name_exists" };

/** Outcome of attempting to update an existing user's name, role, status, or password. */
export type UserMutationResult =
  | { ok: true; user: AuthenticatedUser }
  | {
      ok: false;
      reason:
        | "not_found"
        | "last_admin"
        | "invalid_role"
        | "name_exists"
        | "invalid_current_password";
    };

/** Raw shape of a `users` table row as returned directly by the database driver. */
export type StoredUserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  active: number;
};

/** Decoded claims of an access token issued by {@link TokenService}. */
export type TokenPayload = {
  /** Token issuer, always `"obsync"`. */
  iss: "obsync";
  /** Intended audience, always `"obsync-api"`. */
  aud: "obsync-api";
  /** Subject: the authenticated user's id, as a string. */
  sub: string;
  /** Session id linking this token to a server-side session record. */
  sid: string;
  /** Unique token id (JWT ID), used to make each issued token distinguishable. */
  jti: string;
  /** Issued-at time, in seconds since the Unix epoch. */
  iat: number;
  /** Not-before time, in seconds since the Unix epoch. */
  nbf: number;
  /** Expiration time, in seconds since the Unix epoch. */
  exp: number;
};
