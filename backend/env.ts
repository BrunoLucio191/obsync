import path from "node:path";

try {
  process.loadEnvFile(path.join(import.meta.dirname, ".env"));
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
