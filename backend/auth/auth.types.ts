/** Only admins manage users and change the shared vault. */
export type UserRole = "admin" | "user";

export type AuthenticatedUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  /** Lowercase `#rrggbb`. */
  color: string;
};

export type AuthSession = {
  token: string;
  refreshToken: string;
  /** In seconds. */
  expiresIn: number;
  user: AuthenticatedUser;
};

export type WebSocketChannel = "system" | "yjs";

export type WebSocketTicket = {
  ticket: string;
  expiresIn: number;
};

export type CreateUserResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "email_exists" | "name_exists" };

export type UserMutationResult =
  | { ok: true; user: AuthenticatedUser }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "LAST_ADMIN"
        | "INVALID_ROLE"
        | "NAME_EXISTS"
        | "INVALID_CURRENT_PASSWORD";
    };

export type AuthMutationResul =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "missing_header_info" };

export type StoredUserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  active: number;
  color: string;
};

export type TokenPayload = {
  iss: "obsync";
  aud: "obsync-api";
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
};
