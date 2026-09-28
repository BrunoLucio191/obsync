import "../env.ts";
import { systemPaths } from "../paths.ts";
import { createUserDatabase } from "../users/databaseLifecycle.ts";

async function main(): Promise<void> {
  await createUserDatabase(systemPaths.usersDatabase);
  console.log(`[Database] Database created and seed applied at: ${systemPaths.usersDatabase}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
