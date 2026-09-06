import { hashPassword, passwordMatches } from "../auth/PasswordUtil.ts";
import type {
  AuthenticatedUser,
  CreateUserResult,
  StoredUserRow,
  UserMutationResult,
  UserRole,
} from "../auth/auth.types.ts";
import { UserDB } from "./UserDB.ts";
import { normalizeEmailKey, normalizeName, normalizeNameKey } from "./userNormalization.ts";
import { dbEvents } from "./DBEvents.ts";

/**
 * Application-level service layer over {@link UserDB}: implements user
 * CRUD, authentication-adjacent lookups, and business rules (e.g. never
 * allow the last active administrator to be demoted/deactivated/deleted),
 * wrapping mutations in transactions and emitting authorization-change
 * events when relevant.
 */
export class DBServices {
  /** Facade for emitting/subscribing to authorization-change notifications. */
  private readonly event;
  /** Underlying SQLite-backed user store. */
  private readonly userDB: UserDB;

  constructor(userDB: UserDB) {
    this.userDB = userDB;
    this.event = dbEvents();
  }

  /** Type guard checking whether a value is a valid {@link UserRole}. */
  public isUserRole(value: unknown): value is UserRole {
    return value === "admin" || value === "user";
  }

  /**
   * Fetches a single user row by id, excluding the password hash.
   *
   * @param userId - id of the user to look up.
   * @returns The row, or `null` if no user with that id exists.
   */
  private getUserRow(userId: number): Omit<StoredUserRow, "password_hash"> | null {
    const row = this.userDB
      .prepare("SELECT id, email, name, role, active FROM users WHERE id = ?")
      .get(userId) as Omit<StoredUserRow, "password_hash"> | undefined;
    return row ?? null;
  }

  /**
   * Counts how many users currently hold the `admin` role and are active,
   * used to guard against removing the last administrator.
   *
   * @returns The number of active administrators.
   */
  private activeAdminCount(): number {
    const row = this.userDB
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1")
      .get() as { count: number };
    return Number(row.count);
  }

  /**
   * Runs `operation` inside a SQLite `BEGIN IMMEDIATE` transaction,
   * committing on success and rolling back if it throws.
   *
   * @param operation - Synchronous unit of work to run transactionally.
   * @returns Whatever `operation` returns.
   * @throws Re-throws any error from `operation` after rolling back.
   */
  public runImmediateTransaction<T>(operation: () => T): T {
    this.userDB.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.userDB.exec("COMMIT");
      return result;
    } catch (error) {
      this.userDB.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Converts a raw database row into the public {@link AuthenticatedUser}
   * shape, validating the stored role and coercing `active` to a boolean.
   *
   * @param row - Row as read from the `users` table (without the password hash).
   * @returns The corresponding {@link AuthenticatedUser}.
   * @throws If the row's `role` column holds an invalid value.
   */
  public rowToUser(row: Omit<StoredUserRow, "password_hash">): AuthenticatedUser {
    if (!this.isUserRole(row.role)) {
      throw new Error(`Invalid role stored for user ${row.id}.`);
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as UserRole,
      active: row.active === 1,
    };
  }

  /**
   * Looks up a user by id.
   *
   * @param userId - id of the user to fetch.
   * @param includeInactive - When `false` (default), a deactivated user is treated as not found.
   * @returns The matching user, or `null` if not found (or inactive and `includeInactive` is `false`).
   */
  public async getUserById(
    userId: number,
    includeInactive = false,
  ): Promise<AuthenticatedUser | null> {
    const row = this.getUserRow(userId);
    if (!row || (!includeInactive && row.active !== 1)) return null;
    return this.rowToUser(row);
  }

  /**
   * Lists every user in the database (active and inactive), ordered by id.
   *
   * @returns All users.
   */
  public async listUsers(): Promise<AuthenticatedUser[]> {
    const rows = this.userDB
      .prepare(
        `SELECT id, email, name, role, active
         FROM users
         ORDER BY id ASC`,
      )
      .all() as Array<Omit<StoredUserRow, "password_hash">>;
    return rows.map((row) => this.rowToUser(row));
  }

  /**
   * Creates a new user account, rejecting the operation if the email or
   * the case-insensitive name is already taken. The whole check-then-insert
   * sequence runs inside a transaction to avoid race conditions.
   *
   * @param name - Display name for the new user.
   * @param email - Login email for the new user.
   * @param password - Plaintext password to hash and store.
   * @param role - Role to assign (defaults to `"user"`).
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason }` if the email or name is already in use.
   */
  public async createUser(
    name: string,
    email: string,
    password: string,
    role: UserRole = "user",
  ): Promise<CreateUserResult> {
    const normalizedEmail = normalizeEmailKey(email);
    const normalizedName = normalizeName(name);
    const emailKey = normalizeEmailKey(normalizedEmail);
    const nameKey = normalizeNameKey(normalizedName);
    const passwordHash = await hashPassword(password);

    const result = this.runImmediateTransaction<CreateUserResult>(() => {
      const existingEmail = this.userDB
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(emailKey);
      if (existingEmail) return { ok: false, reason: "email_exists" };

      const existingName = this.userDB
        .prepare("SELECT id FROM users WHERE name_key = ?")
        .get(nameKey);
      if (existingName) return { ok: false, reason: "name_exists" };

      this.userDB
        .prepare(
          `INSERT INTO users
           (email, name, name_key, password_hash, role, active)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .run(normalizedEmail, normalizedName, nameKey, passwordHash, role);

      const row = this.userDB
        .prepare("SELECT id, email, name, role, active FROM users WHERE email = ?")
        .get(emailKey) as Omit<StoredUserRow, "password_hash"> | undefined;
      if (!row) throw new Error("The created user could not be loaded.");
      return { ok: true, user: this.rowToUser(row) };
    });

    return result;
  }

  /**
   * Renames a user, rejecting the change if another user already has the
   * same case-insensitive name. Emits an authorization-changed event on
   * success (the name is part of the authenticated user's identity data).
   *
   * @param userId - id of the user to rename.
   * @param name - New display name.
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason }` if the user doesn't exist or the name is taken.
   */
  public async updateUserName(userId: number, name: string): Promise<UserMutationResult> {
    const normalizedName = normalizeName(name);
    const nameKey = normalizeNameKey(normalizedName);
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "NOT_FOUND" };

      const existing = this.userDB
        .prepare("SELECT id FROM users WHERE name_key = ? AND id != ?")
        .get(nameKey, userId);
      if (existing) return { ok: false, reason: "NAME_EXISTS" };

      this.userDB
        .prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ?")
        .run(normalizedName, nameKey, userId);

      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  /**
   * Changes a user's role, refusing to demote the last remaining active
   * administrator (to avoid locking everyone out of admin capabilities).
   * Emits an authorization-changed event on success.
   *
   * @param userId - id of the user whose role should change.
   * @param role - New role to assign.
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason }` if `role` is invalid, the user doesn't exist, or this would remove the last active admin.
   */
  public async updateUserRole(userId: number, role: UserRole): Promise<UserMutationResult> {
    if (!this.isUserRole(role)) return { ok: false, reason: "INVALID_ROLE" };

    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "NOT_FOUND" };

      if (
        row.role === "admin" &&
        row.active === 1 &&
        role === "user" &&
        this.activeAdminCount() <= 1
      ) {
        return { ok: false, reason: "LAST_ADMIN" };
      }

      this.userDB.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
      const updated = this.getUserRow(userId);

      if (!updated) return { ok: false, reason: "NOT_FOUND" };

      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  /**
   * Activates or deactivates a user, refusing to deactivate the last
   * remaining active administrator. Emits an authorization-changed event
   * on success.
   *
   * @param userId - id of the user to activate/deactivate.
   * @param active - Desired active status.
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason }` if the user doesn't exist or this would remove the last active admin.
   */
  public async updateUserStatus(userId: number, active: boolean): Promise<UserMutationResult> {
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "NOT_FOUND" };
      if (row.role === "admin" && row.active === 1 && !active && this.activeAdminCount() <= 1) {
        return { ok: false, reason: "LAST_ADMIN" };
      }

      this.userDB.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, userId);
      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  /**
   * Self-service password change: verifies the caller's current password
   * before setting the new one.
   *
   * @param userId - id of the user changing their own password.
   * @param currentPassword - The user's current plaintext password, for verification.
   * @param newPassword - New plaintext password to hash and store.
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason }` if the user doesn't exist or `currentPassword` doesn't match.
   */
  public async updateUserPassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserMutationResult> {
    const row = this.userDB
      .prepare("SELECT id, email, name, password_hash, role, active FROM users WHERE id = ?")
      .get(userId) as StoredUserRow | undefined;
    if (!row) return { ok: false, reason: "NOT_FOUND" };

    if (!(await passwordMatches(currentPassword, row.password_hash))) {
      return { ok: false, reason: "INVALID_CURRENT_PASSWORD" };
    }

    const passwordHash = await hashPassword(newPassword);

    return this.runImmediateTransaction<UserMutationResult>(() => {
      const current = this.getUserRow(userId);
      if (!current) return { ok: false, reason: "NOT_FOUND" };

      this.userDB
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(passwordHash, userId);

      return { ok: true, user: this.rowToUser(current) };
    });
  }

  /**
   * Administrative password reset: sets a user's password without
   * requiring their current password (for use by an administrator).
   *
   * @param userId - id of the user whose password is being reset.
   * @param newPassword - New plaintext password to hash and store.
   * @returns `{ ok: true, user }` on success, or `{ ok: false, reason: "not_found" }` if the user doesn't exist.
   */
  public async adminSetUserPassword(
    userId: number,
    newPassword: string,
  ): Promise<UserMutationResult> {
    const passwordHash = await hashPassword(newPassword);

    return this.runImmediateTransaction<UserMutationResult>(() => {
      const current = this.getUserRow(userId);
      if (!current) return { ok: false, reason: "NOT_FOUND" };

      this.userDB
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(passwordHash, userId);

      return { ok: true, user: this.rowToUser(current) };
    });
  }

  /**
   * Permanently deletes a user, refusing to delete the last remaining
   * active administrator. Emits an authorization-changed event on success.
   *
   * @param userId - id of the user to delete.
   * @returns `{ ok: true, user }` (the deleted user) on success, or `{ ok: false, reason }` if the user doesn't exist or this would remove the last active admin.
   */
  public async deleteUser(userId: number): Promise<UserMutationResult> {
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "NOT_FOUND" };

      if (row.role === "admin" && row.active === 1 && this.activeAdminCount() <= 1) {
        return { ok: false, reason: "LAST_ADMIN" };
      }

      const user = this.rowToUser(row);
      this.userDB.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return { ok: true, user };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }
}
