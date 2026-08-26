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
    `[Database] User database not found at: ${databasePath}`,
    `[Database] Run '${DATABASE_SETUP_COMMAND}' from the project root before starting the backend.`,
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
        `[Database] Invalid user database at: ${databasePath}`,
        `[Database] Reason: ${reason}`,
        "[Database] Fix or restore the file. To recreate it, back it up, remove the invalid file, and run " +
          `'${DATABASE_SETUP_COMMAND}'.`,
      ].join("\n"),
    );
  }
}

export async function createUserDatabase(databasePath: string): Promise<void> {
  if (existsSync(databasePath)) {
    throw new Error(
      `[Database] The user database already exists at: ${databasePath}\n` +
        "[Database] No file was changed.",
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
