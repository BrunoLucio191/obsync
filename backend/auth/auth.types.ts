export type UserRole = "admin" | "user";

export type AuthenticatedUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
};

export type AuthSession = {
  token: string;
  user: AuthenticatedUser;
};

export type CreateUserResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "email_exists" | "name_exists" };

export type UserMutationResult =
  | { ok: true; user: AuthenticatedUser }
  | {
      ok: false;
      reason:
        | "not_found"
        | "last_admin"
        | "self_deactivate"
        | "self_delete"
        | "invalid_role"
        | "name_exists";
    };

export type StoredUserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  active: number;
};

export type TokenPayload = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  exp: number;
};
