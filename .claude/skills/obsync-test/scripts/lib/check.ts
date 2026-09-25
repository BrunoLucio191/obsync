// Compact pass/fail reporting: one summary line, details only for what failed.

export function createChecks(title: string, out: (line: string) => void) {
  const failures: string[] = [];
  let total = 0;
  return {
    async check(name: string, fn: () => unknown) {
      total++;
      try {
        await fn();
      } catch (error) {
        failures.push(`  FALHOU ${name}: ${(error as Error).message.split("\n").slice(0, 6).join(" ")}`);
      }
    },
    /** Prints the summary and returns the process exit code. */
    finish(extra: string[] = []) {
      out(`${failures.length ? "FALHOU" : "ok"} ${title}: ${total - failures.length}/${total}`);
      for (const line of [...failures, ...extra]) out(line);
      return failures.length ? 1 : 0;
    },
  };
}
