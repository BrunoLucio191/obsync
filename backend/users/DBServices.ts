import { hashPassword, passwordMatches } from "../auth/PasswordUtil.ts";
import type {
  AuthenticatedUser,
  CreateUserResult,
  StoredUserRow,
  UserMutationResult,
  UserRole,
} from "../auth/auth.types.ts";
import { UserDB } from "./UserDB.ts";
import {
  normalizeEmailKey,
  normalizeName,
  normalizeNameKey,
} from "./userNormalization.ts";
import { dbEvents } from "./DBEvents.ts";

export class DBServices {
  private readonly event;
  private readonly userDB: UserDB;
  constructor(userDB: UserDB) {
    this.userDB = userDB;
    this.event = dbEvents();
  }

  public isUserRole(value: unknown): value is UserRole {
    return value === "admin" || value === "user";
  }

  private getUserRow(
    userId: number,
  ): Omit<StoredUserRow, "password_hash"> | null {
    const row = this.userDB
      .prepare("SELECT id, email, name, role, active FROM users WHERE id = ?")
      .get(userId) as Omit<StoredUserRow, "password_hash"> | undefined;
    return row ?? null;
  }

  private activeAdminCount(): number {
    const row = this.userDB
      .prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1",
      )
      .get() as { count: number };
    return Number(row.count);
  }

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

  public rowToUser(
    row: Omit<StoredUserRow, "password_hash">,
  ): AuthenticatedUser {
    if (!this.isUserRole(row.role)) {
      throw new Error(`Papel inválido armazenado para o usuário ${row.id}.`);
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as UserRole,
      active: row.active === 1,
    };
  }

  public async getUserById(
    userId: number,
    includeInactive = false,
  ): Promise<AuthenticatedUser | null> {
    const row = this.getUserRow(userId);
    if (!row || (!includeInactive && row.active !== 1)) return null;
    return this.rowToUser(row);
  }

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
        .prepare(
          "SELECT id, email, name, role, active FROM users WHERE email = ?",
        )
        .get(emailKey) as Omit<StoredUserRow, "password_hash"> | undefined;
      if (!row) throw new Error("O usuário criado não pôde ser carregado.");
      return { ok: true, user: this.rowToUser(row) };
    });

    return result;
  }

  public async updateUserName(
    userId: number,
    name: string,
  ): Promise<UserMutationResult> {
    const normalizedName = normalizeName(name);
    const nameKey = normalizeNameKey(normalizedName);
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };

      const existing = this.userDB
        .prepare("SELECT id FROM users WHERE name_key = ? AND id != ?")
        .get(nameKey, userId);
      if (existing) return { ok: false, reason: "name_exists" };

      this.userDB
        .prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ?")
        .run(normalizedName, nameKey, userId);

      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "not_found" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  public async updateUserRole(
    userId: number,
    role: UserRole,
  ): Promise<UserMutationResult> {
    if (!this.isUserRole(role)) return { ok: false, reason: "invalid_role" };

    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };

      if (
        row.role === "admin" &&
        row.active === 1 &&
        role === "user" &&
        this.activeAdminCount() <= 1
      ) {
        return { ok: false, reason: "last_admin" };
      }

      this.userDB
        .prepare("UPDATE users SET role = ? WHERE id = ?")
        .run(role, userId);
      const updated = this.getUserRow(userId);

      if (!updated) return { ok: false, reason: "not_found" };

      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  public async updateUserStatus(
    userId: number,
    active: boolean,
  ): Promise<UserMutationResult> {
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };
      if (
        row.role === "admin" &&
        row.active === 1 &&
        !active &&
        this.activeAdminCount() <= 1
      ) {
        return { ok: false, reason: "last_admin" };
      }

      this.userDB
        .prepare("UPDATE users SET active = ? WHERE id = ?")
        .run(active ? 1 : 0, userId);
      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "not_found" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }

  public async updateUserPassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserMutationResult> {
    const row = this.userDB
      .prepare(
        "SELECT id, email, name, password_hash, role, active FROM users WHERE id = ?",
      )
      .get(userId) as StoredUserRow | undefined;
    if (!row) return { ok: false, reason: "not_found" };

    if (!(await passwordMatches(currentPassword, row.password_hash))) {
      return { ok: false, reason: "invalid_current_password" };
    }

    const passwordHash = await hashPassword(newPassword);

    return this.runImmediateTransaction<UserMutationResult>(() => {
      const current = this.getUserRow(userId);
      if (!current) return { ok: false, reason: "not_found" };

      this.userDB
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(passwordHash, userId);

      return { ok: true, user: this.rowToUser(current) };
    });
  }

  public async deleteUser(userId: number): Promise<UserMutationResult> {
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };

      if (
        row.role === "admin" &&
        row.active === 1 &&
        this.activeAdminCount() <= 1
      ) {
        return { ok: false, reason: "last_admin" };
      }

      const user = this.rowToUser(row);
      this.userDB.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return { ok: true, user };
    });

    if (result.ok) this.event.emitAuthorizationChanged(userId);
    return result;
  }
}
