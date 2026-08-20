import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { UserDB } from "./UserDB.ts";

export const DATABASE_SETUP_COMMAND = "npm run db:setup";

function missingDatabaseInstruction(databasePath: string): string {
  return [
    `[Database] Banco de usuários não encontrado em: ${databasePath}`,
    `[Database] Execute '${DATABASE_SETUP_COMMAND}' na raiz do projeto antes de iniciar o backend.`,
  ].join("\n");
}

export function openUserDatabase(databasePath: string): UserDB {
  if (!existsSync(databasePath)) {
    throw new Error(missingDatabaseInstruction(databasePath));
  }

  const database = new UserDB(databasePath);

  try {
    database.prepareForRuntime();
    return database;
  } catch (error) {
    database.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `[Database] Banco de usuários inválido em: ${databasePath}`,
        `[Database] Motivo: ${reason}`,
        "[Database] Corrija ou restaure o arquivo. Para recriá-lo, faça backup, remova o arquivo inválido e execute " +
          `'${DATABASE_SETUP_COMMAND}'.`,
      ].join("\n"),
    );
  }
}

export async function createUserDatabase(databasePath: string): Promise<void> {
  if (existsSync(databasePath)) {
    throw new Error(
      `[Database] O banco de usuários já existe em: ${databasePath}\n` +
        "[Database] Nenhum arquivo foi alterado.",
    );
  }

  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new UserDB(databasePath);

  try {
    await database.setup();
  } catch (error) {
    database.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    throw error;
  }

  database.close();
}
