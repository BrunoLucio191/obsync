import "../env.ts";
import { systemPaths } from "../paths.ts";
import { createUserDatabase } from "../users/databaseLifecycle.ts";

/**
 * CLI script entry point: creates the users database file (applying any
 * initial seed) at the configured path.
 */
async function main(): Promise<void> {
  await createUserDatabase(systemPaths.usersDatabase);
  console.log(`[Database] Database created and seed applied at: ${systemPaths.usersDatabase}`);
}

/**
 * Runs {@link main} and, on failure, logs the error and sets a non-zero
 * exit code instead of leaving an unhandled promise rejection.
 */
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
