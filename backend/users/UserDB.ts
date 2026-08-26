import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeEmailKey,
  normalizeName,
  normalizeNameKey,
} from "./userNormalization.ts";
import { hashPassword } from "../auth/PasswordUtil.ts";

type SeededUser = { id: number; email: string; password: string };

function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url");
}

export class UserDB extends DatabaseSync {
  constructor(path: string) {
    super(path);
  }

  public async setup(): Promise<void> {
    this.createSchema();
    this.configDataBase();
    const seeded = await this.createInitialUsers();
    const adminId = this.ensureInitialAdministrator();
    this.printSeedSummary(seeded, adminId);
  }

  public prepareForRuntime(): void {
    const usersTable = this.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    ).get() as { found: number } | undefined;

    if (!usersTable) {
      throw new Error("A tabela obrigatória 'users' não existe.");
    }

    const activeAdministrator = this.prepare(
      "SELECT 1 AS found FROM users WHERE role = 'admin' AND active = 1 LIMIT 1",
    ).get() as { found: number } | undefined;

    if (!activeAdministrator) {
      throw new Error("Não existe um administrador ativo no banco de dados.");
    }

    this.configDataBase();
  }

  private configDataBase(): void {
    this.exec("PRAGMA journal_mode = WAL");
  }
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

  private ensureInitialAdministrator(): number {
    const first = this.prepare(
      "SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT 1",
    ).get() as { id: number } | undefined;
    if (!first) {
      throw new Error(
        "Não existe usuário ativo para promover a administrador.",
      );
    }
    this.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
    return first.id;
  }

  private printSeedSummary(seeded: SeededUser[], adminId: number): void {
    console.log("[Database] Seed: contas iniciais criadas.");
    for (const user of seeded) {
      const role = user.id === adminId ? "admin" : "user";
      console.log(
        `[Database]   ${user.email} — senha temporária (${role}): ${user.password}`,
      );
    }
    console.log(
      "[Database] Guarde essas senhas agora: elas não serão exibidas novamente. " +
        "Entre no Obsidian e troque-as em Configurações do ObSync → Conta → Trocar senha.",
    );
  }
}
