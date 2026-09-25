// Runs obSync scenarios, each in its own process group with a time limit, then removes leftover
// temp dirs and fails if anything under backend/data changed.
// Usage: node run.ts [all | <scenario>...] [--timeout 120] [flags passed to the scenarios]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SCENARIOS = ["queue", "move", "getfile", "gene", "color", "multiuser"];
const REPO = path.resolve(import.meta.dirname, "../../../..");
const DATA = path.join(REPO, "backend/data");

const args = process.argv.slice(2);
const named = args.filter((a) => a === "all" || SCENARIOS.includes(a));
const selected = named.length === 0 || named.includes("all") ? SCENARIOS : named;
const timeoutIndex = args.indexOf("--timeout");
const timeoutS = timeoutIndex === -1 ? 120 : Number(args[timeoutIndex + 1]);
const passThrough = args.filter(
  (a, i) => !named.includes(a) && i !== timeoutIndex && i !== timeoutIndex + 1,
);

async function snapshot(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  const lines = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(e.parentPath, e.name);
      const stat = await fs.stat(full).catch(() => null);
      return stat ? `${full} ${stat.size} ${stat.mtimeMs}` : `${full} gone`;
    }),
  );
  return lines.sort();
}

function runScenario(name: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "scenarios", `${name}.ts`), ...passThrough],
      { stdio: "inherit", detached: true },
    );
    const timer = setTimeout(() => {
      console.log(`FALHOU ${name}: passou do limite de ${timeoutS}s`);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutS * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

const before = await snapshot(DATA);
let passed = 0;
for (const name of selected) if ((await runScenario(name)) === 0) passed++;

for (const entry of await fs.readdir(os.tmpdir())) {
  if (entry.startsWith("obsync-test-")) {
    await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true });
  }
}
const after = await snapshot(DATA);
const dataChanged = JSON.stringify(before) !== JSON.stringify(after);
if (dataChanged) console.log("ATENCAO: algo em backend/data mudou durante os testes");
console.log(`resumo: ${passed}/${selected.length} cenarios ok`);
process.exit(passed === selected.length && !dataChanged ? 0 : 1);
