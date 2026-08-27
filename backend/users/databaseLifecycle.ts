import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { UserDB } from "./UserDB.ts";

/** Command the operator should run to create the user database from scratch. */
export const DATABASE_SETUP_COMMAND = "npm run db:setup";

/**
 * Builds the multi-line log message shown when the backend is started but
 * the user database file does not exist yet.
 *
 * @param databasePath - Absolute path where the database file was expected.
 * @returns A human-readable instruction block to print/throw.
 */
function missingDatabaseInstruction(databasePath: string): string {
  return [
    `[Database] User database not found at: ${databasePath}`,
    `[Database] Run '${DATABASE_SETUP_COMMAND}' from the project root before starting the backend.`,
  ].join("\n");
}

/**
 * Opens an existing user database for runtime use, validating that it has
 * a usable schema and at least one active administrator before handing it
 * back to the caller.
 *
 * @param databasePath - Absolute path to the SQLite database file.
 * @returns The opened, validated {@link UserDB} instance.
 * @throws If the file does not exist, or if it exists but fails validation
 * (in which case the database is closed before the error is thrown).
 */
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

/**
 * Creates a brand-new user database file, seeded with the initial schema
 * and default accounts. If setup fails partway through, the partially
 * created database file (and its WAL/SHM sidecar files) are removed so no
 * corrupt database is left behind.
 *
 * @param databasePath - Absolute path where the new database file should be created.
 * @throws If a database already exists at `databasePath`, or if setup fails.
 */
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
