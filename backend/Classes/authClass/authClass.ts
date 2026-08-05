import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import path from "node:path";
import { FileManager } from "../fileManipulationClass.ts";
import type {
  AuthenticatedUser,
  AuthSession,
  CreateUserResult,
  StoredUserRow,
  TokenPayload,
  UserMutationResult,
  UserRole,
} from "./authClassTypes.ts";

export class AuthService {
  private readonly database: DatabaseSync;
  private readonly events = new EventEmitter();
  private readonly secret = process.env.OBISYNC_TOKEN_SECRET!;
  private readonly ready: Promise<void>;
  private fileManager = new FileManager();
  private TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
  private scryptAsync = promisify(scrypt);

  public constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.ready = this.initialize();
  }
  //MARK: create db fns
  private async initialize(): Promise<void> {
    this.database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,

          email TEXT NOT NULL UNIQUE,

          name TEXT NOT NULL,
          name_key TEXT NOT NULL UNIQUE,

          password_hash TEXT NOT NULL,

          role TEXT NOT NULL DEFAULT 'user'
            CHECK(role IN('admin','user')),
            
          active INTEGER NOT NULL DEFAULT 1
            CHECK(active IN(0,1))
        );

        CREATE INDEX IF NOT EXISTS idx_users_role_active
          ON users(role,active);
      `);

    this.migrateIdentityKeys();

    await this.seedUsers();
    this.ensureInitialAdministrator();
  }

  //produce keys for searching and verify uniques from e-mail and name
  private migrateIdentityKeys(): void {
    const rows = this.database
      .prepare("SELECT id, email, name FROM users ORDER BY id")
      .all() as Array<{ id: number; email: string; name: string }>;
    const emailOwners = new Map<string, number>();
    const nameOwners = new Map<string, number>();
    const update = this.database.prepare(
      "UPDATE users SET email = ?, name = ?, name_key = ? WHERE id = ?",
    );

    this.runImmediateTransaction(() => {
      for (const row of rows) {
        const email = this.fileManager.normalizeEmailKey(row.email);
        const name = this.fileManager.normalizeName(row.name);
        const nameKey = this.fileManager.normalizeNameKey(name);
        const emailOwner = emailOwners.get(email);
        const nameOwner = nameOwners.get(email);

        if (emailOwner !== undefined) {
          throw new Error(
            `Não foi possível aplicar a restrição de e-mail único: usuários ${emailOwner} e ${row.id} possuem o mesmo e-mail.`,
          );
        }
        if (nameOwner !== undefined) {
          throw new Error(
            `Não foi possível aplicar a restrição de nome único: usuários ${nameOwner} e ${row.id} possuem o mesmo nome.`,
          );
        }

        emailOwners.set(email, row.id);
        nameOwners.set(nameKey, row.id);
        update.run(email, name, nameKey, row.id);
      }
    });
  }
  //add inital users to the database
  private async seedUsers(): Promise<void> {
    const users = [
      { email: "thiago@gmail.com", name: "Thiago", password: "123456" },
      { email: "brunoestudos6@gmail.com", name: "Bruno", password: "123456" },
    ];
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO users
       (email, name, name_key, password_hash, role, active)
       VALUES (?, ?, ?, ?, 'user', 1)`,
    );

    for (const user of users) {
      const email = this.fileManager.normalizeEmailKey(user.email);
      const name = this.fileManager.normalizeName(user.name);
      insert.run(
        email,
        name,
        this.fileManager.normalizeNameKey(name),
        await this.hashPassword(user.password),
      );
    }
  }
  //prevent some edge cases for admintrator role
  private ensureInitialAdministrator(): void {
    const existing = this.database
      .prepare(
        "SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1",
      )
      .get();
    if (existing) return;

    const first = this.database
      .prepare(
        "SELECT id, email FROM users WHERE active = 1 ORDER BY id LIMIT 1",
      )
      .get() as { id: number; email: string } | undefined;
    if (!first) {
      throw new Error(
        "Não existe usuário ativo para promover a administrador.",
      );
    }

    this.database
      .prepare("UPDATE users SET role = 'admin' WHERE id = ?")
      .run(first.id);
    console.log(
      `[Auth] Migração RBAC: usuário id=${first.id} promovido a administrador inicial.`,
    );
  }
  //MARK: token/password fns
  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");

    const passwordNormalized = password.normalize("NFC");

    const hash = (await this.scryptAsync(
      passwordNormalized,
      salt,
      64,
    )) as Buffer;

    return `${salt}:${hash.toString("hex")}`;
  }

  private async passwordMatches(
    password: string,
    storedHash: string,
  ): Promise<boolean> {
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return false;

    const candidate = (await this.scryptAsync(password, salt, 64)) as Buffer;

    const expected = Buffer.from(hash, "hex");
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  private issueToken(user: AuthenticatedUser): string {
    const header = this.fileManager.encode({ alg: "HS256", typ: "JWT" });
    const payload = this.fileManager.encode({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + this.TOKEN_LIFETIME_SECONDS,
    });
    const signed = `${header}.${payload}`;
    return `${signed}.${this.sign(signed)}`;
  }

  private sessionFor(user: AuthenticatedUser): AuthSession {
    return { token: this.issueToken(user), user };
  }
  //MARK: search db
  private rowToUser(
    row: Omit<StoredUserRow, "password_hash">,
  ): AuthenticatedUser {
    if (!this.fileManager.isUserRole(row.role)) {
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

  private getUserRow(
    userId: number,
  ): Omit<StoredUserRow, "password_hash"> | null {
    const row = this.database
      .prepare("SELECT id, email, name, role, active FROM users WHERE id = ?")
      .get(userId) as Omit<StoredUserRow, "password_hash"> | undefined;
    return row ?? null;
  }

  private activeAdminCount(): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1",
      )
      .get() as { count: number };
    return Number(row.count);
  }
  //MARK: helper fns
  private runImmediateTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private emitAuthorizationChanged(userId: number): void {
    this.events.emit("authorization-changed", userId);
  }

  public onAuthorizationChanged(
    listener: (userId: number) => void,
  ): () => void {
    this.events.on("authorization-changed", listener);
    return () => this.events.off("authorization-changed", listener);
  }
  //MARK: user fns
  public async login(
    email: string,
    password: string,
  ): Promise<AuthSession | null> {
    await this.ready;
    const row = this.database
      .prepare(
        `SELECT id, email, name, password_hash, role, active
         FROM users WHERE email = ? AND active = 1`,
      )
      .get(this.fileManager.normalizeEmailKey(email)) as
      | StoredUserRow
      | undefined;
    if (!row || !(await this.passwordMatches(password, row.password_hash))) {
      return null;
    }

    return this.sessionFor(this.rowToUser(row));
  }

  public async getUserById(
    userId: number,
    includeInactive = false,
  ): Promise<AuthenticatedUser | null> {
    await this.ready;
    const row = this.getUserRow(userId);
    if (!row || (!includeInactive && row.active !== 1)) return null;
    return this.rowToUser(row);
  }

  public async listUsers(): Promise<AuthenticatedUser[]> {
    await this.ready;
    const rows = this.database
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
    await this.ready;
    const normalizedEmail = this.fileManager.normalizeEmailKey(email);
    const normalizedName = this.fileManager.normalizeName(name);
    const emailKey = this.fileManager.normalizeEmailKey(normalizedEmail);
    const nameKey = this.fileManager.normalizeNameKey(normalizedName);
    const passwordHash = await this.hashPassword(password);

    const result = this.runImmediateTransaction<CreateUserResult>(() => {
      const existingEmail = this.database
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(emailKey);
      if (existingEmail) return { ok: false, reason: "email_exists" };

      const existingName = this.database
        .prepare("SELECT id FROM users WHERE name_key = ?")
        .get(nameKey);
      if (existingName) return { ok: false, reason: "name_exists" };

      this.database
        .prepare(
          `INSERT INTO users
           (email, name, name_key, password_hash, role, active)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .run(normalizedEmail, normalizedName, nameKey, passwordHash, role);

      const row = this.database
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
    await this.ready;
    const normalizedName = this.fileManager.normalizeName(name);
    const nameKey = this.fileManager.normalizeNameKey(normalizedName);
    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };

      const existing = this.database
        .prepare("SELECT id FROM users WHERE name_key = ? AND id != ?")
        .get(nameKey, userId);
      if (existing) return { ok: false, reason: "name_exists" };

      this.database
        .prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ?")
        .run(normalizedName, nameKey, userId);

      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "not_found" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.emitAuthorizationChanged(userId);
    return result;
  }

  public async updateUserRole(
    userId: number,
    role: UserRole,
  ): Promise<UserMutationResult> {
    await this.ready;
    if (!this.fileManager.isUserRole(role))
      return { ok: false, reason: "invalid_role" };

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

      this.database
        .prepare("UPDATE users SET role = ? WHERE id = ?")
        .run(role, userId);
      const updated = this.getUserRow(userId);

      if (!updated) return { ok: false, reason: "not_found" };

      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.emitAuthorizationChanged(userId);
    return result;
  }

  public async updateUserStatus(
    actorUserId: number,
    userId: number,
    active: boolean,
  ): Promise<UserMutationResult> {
    await this.ready;

    const result = this.runImmediateTransaction<UserMutationResult>(() => {
      const row = this.getUserRow(userId);
      if (!row) return { ok: false, reason: "not_found" };

      if (actorUserId === userId && !active) {
        return { ok: false, reason: "self_deactivate" };
      }

      if (
        row.role === "admin" &&
        row.active === 1 &&
        !active &&
        this.activeAdminCount() <= 1
      ) {
        return { ok: false, reason: "last_admin" };
      }

      this.database
        .prepare("UPDATE users SET active = ? WHERE id = ?")
        .run(active ? 1 : 0, userId);
      const updated = this.getUserRow(userId);
      if (!updated) return { ok: false, reason: "not_found" };
      return { ok: true, user: this.rowToUser(updated) };
    });

    if (result.ok) this.emitAuthorizationChanged(userId);
    return result;
  }

  public async deleteUser(
    actorUserId: number,
    userId: number,
  ): Promise<UserMutationResult> {
    await this.ready;
    if (actorUserId === userId) return { ok: false, reason: "self_delete" };

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
      this.database.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return { ok: true, user };
    });

    if (result.ok) this.emitAuthorizationChanged(userId);
    return result;
  }
  //MARK: verify token
  public async verifyToken(
    token: string | null | undefined,
  ): Promise<AuthenticatedUser | null> {
    await this.ready;

    if (!token) return null;

    const [header, payload, signature] = token.split(".");

    if (!header || !payload || !signature) return null;

    const signed = `${header}.${payload}`;

    const expected = this.sign(signed);

    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return null;
    }

    try {
      const value = this.fileManager.decode<TokenPayload>(payload);
      if (!value.id || value.exp < Math.floor(Date.now() / 1000)) return null;
      return await this.getUserById(value.id);
    } catch {
      return null;
    }
  }
}

export const usersDatabasePath = path.join(import.meta.dirname, "users.sqlite");
