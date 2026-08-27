import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeEmailKey,
  normalizeName,
  normalizeNameKey,
} from "./userNormalization.ts";
import { hashPassword } from "../auth/PasswordUtil.ts";

/** A user created by the initial database seed, with its one-time plaintext password. */
type SeededUser = { id: number; email: string; password: string };

/**
 * Generates a random, URL-safe temporary password for seeded accounts.
 *
 * @returns A base64url-encoded random password string.
 */
function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * SQLite-backed store for user accounts. Wraps Node's `DatabaseSync` with
 * schema creation, first-run seeding, and startup validation so callers
 * can treat it as a ready-to-query users database.
 */
export class UserDB extends DatabaseSync {
  /** Opens (or creates) the SQLite file at the given path. */
  constructor(path: string) {
    super(path);
  }

  /**
   * Initializes a fresh database: creates the schema, applies runtime
   * pragmas, seeds initial user accounts, promotes one of them to
   * administrator, and prints the generated credentials to the console.
   */
  public async setup(): Promise<void> {
    this.createSchema();
    this.configDataBase();
    const seeded = await this.createInitialUsers();
    const adminId = this.ensureInitialAdministrator();
    this.printSeedSummary(seeded, adminId);
  }

  /**
   * Validates that an already-existing database is safe to use at
   * runtime (has the `users` table and at least one active administrator)
   * and applies the runtime pragmas.
   *
   * @throws If the `users` table is missing or no active administrator exists.
   */
  public prepareForRuntime(): void {
    const usersTable = this.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    ).get() as { found: number } | undefined;

    if (!usersTable) {
      throw new Error("The required 'users' table does not exist.");
    }

    const activeAdministrator = this.prepare(
      "SELECT 1 AS found FROM users WHERE role = 'admin' AND active = 1 LIMIT 1",
    ).get() as { found: number } | undefined;

    if (!activeAdministrator) {
      throw new Error("There is no active administrator in the database.");
    }

    this.configDataBase();
  }

  /** Applies runtime SQLite pragmas (enables WAL journal mode for better concurrency). */
  private configDataBase(): void {
    this.exec("PRAGMA journal_mode = WAL");
  }

  /** Creates the `users` table and its indexes if they don't already exist. */
  private createSchema(): void {
    this.exec(`
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
  }
  /**
   * Inserts the hard-coded set of default accounts, skipping any whose
   * email already exists (safe to call on a partially-seeded database).
   * Each inserted account gets a freshly generated temporary password.
   *
   * @returns The list of accounts that were actually inserted, including
   * their plaintext temporary passwords (only available at this moment —
   * they are not recoverable once seeding completes).
   */
  private async createInitialUsers(): Promise<SeededUser[]> {
    const users = [
      { email: "thiago@gmail.com", name: "Thiago" },
      { email: "brunoestudos6@gmail.com", name: "Bruno" },
    ];
    const insert = this.prepare(
      `INSERT OR IGNORE INTO users
       (email, name, name_key, password_hash, role, active)
       VALUES (?, ?, ?, ?, 'user', 1)`,
    );

    const seeded: SeededUser[] = [];

    for (const user of users) {
      const email = normalizeEmailKey(user.email);
      const name = normalizeName(user.name);
      const password = generateTemporaryPassword();
      const result = insert.run(
        email,
        name,
        normalizeNameKey(name),
        await hashPassword(password),
      );

      if (result.changes > 0) {
        seeded.push({ id: Number(result.lastInsertRowid), email, password });
      }
    }

    return seeded;
  }

  /**
   * Promotes the oldest active user to the `admin` role, guaranteeing the
   * freshly-seeded database has someone able to manage it.
   *
   * @returns The id of the user promoted to administrator.
   * @throws If there is no active user available to promote.
   */
  private ensureInitialAdministrator(): number {
    const first = this.prepare(
      "SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT 1",
    ).get() as { id: number } | undefined;
    if (!first) {
      throw new Error(
        "There is no active user to promote to administrator.",
      );
    }
    this.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
    return first.id;
  }

  /**
   * Prints the one-time temporary credentials for newly seeded accounts
   * to the console, since they are not stored anywhere in plaintext.
   *
   * @param seeded - Accounts created during this seeding run.
   * @param adminId - id of the account promoted to administrator, used to label it in the printout.
   */
  private printSeedSummary(seeded: SeededUser[], adminId: number): void {
    console.log("[Database] Seed: initial accounts created.");
    for (const user of seeded) {
      const role = user.id === adminId ? "admin" : "user";
      console.log(
        `[Database]   ${user.email} — temporary password (${role}): ${user.password}`,
      );
    }
    console.log(
      "[Database] Save these passwords now: they will not be shown again. " +
        "Sign in to Obsidian and change them under ObSync Settings -> Account -> Change password.",
    );
  }
}
