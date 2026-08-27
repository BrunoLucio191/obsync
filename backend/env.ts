import path from "node:path";

/**
 * Side-effect module: loads environment variables from a `.env` file located
 * next to this module into `process.env`. Meant to be imported once, early,
 * for its side effect (e.g. `import "./env.ts"`).
 *
 * Missing `.env` files are silently ignored (ENOENT) since environment
 * variables may instead be supplied by the host/OS; any other error
 * (e.g. malformed file) is rethrown.
 */
try {
  process.loadEnvFile(path.join(import.meta.dirname, ".env"));
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
