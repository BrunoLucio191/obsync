import path from "node:path";

/** Imported for its side effect. A missing `.env` is fine: the host may set the variables. */
try {
  process.loadEnvFile(path.join(import.meta.dirname, ".env"));
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
