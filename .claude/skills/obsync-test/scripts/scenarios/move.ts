// Moving and renaming files and folders through the plugin against the real backend.
// Obsidian fires one rename for a folder and then one per descendant; the canonical vault on
// the server must end up exactly like the client's, with no failed request.
// Usage: move.ts [--runs 10]
import fs from "node:fs/promises";
import { captureLogs, fakeObsidian } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { FakeVault, diskTree, waitForQuiet } from "../lib/fake-vault.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { createChecks } from "../lib/check.ts";

const runsIndex = process.argv.indexOf("--runs");
const RUNS = runsIndex === -1 ? 10 : Number(process.argv[runsIndex + 1]);
const logs = captureLogs();
const { netStats } = await fakeObsidian();
const server = await startBackend();
await loadPlugin(server.baseUrl);
const { token } = await server.createUser(0);
const checks = createChecks(`move (${RUNS} rodadas por cenario)`, logs.out);

type Scenario = { name: string; seed: (v: FakeVault) => void; act: (v: FakeVault) => void };
const scenarios: Scenario[] = [
  {
    name: "5 notas da raiz para uma pasta",
    seed: (v) => {
      v.seed("Dest");
      for (let i = 1; i <= 5; i++) v.seed(`n${i}.md`, `note ${i}`);
    },
    act: (v) => {
      for (let i = 1; i <= 5; i++) v.rename(`n${i}.md`, `Dest/n${i}.md`);
    },
  },
  {
    name: "pasta com subpastas para dentro de outra",
    seed: (v) => {
      for (const p of ["Archive", "Proj", "Proj/sub", "Proj/sub/deep"]) v.seed(p);
      for (const p of ["Proj/a.md", "Proj/b.md", "Proj/img.png", "Proj/sub/c.md", "Proj/sub/deep/d.md"]) v.seed(p, p);
    },
    act: (v) => v.rename("Proj", "Archive/Proj"),
  },
  {
    name: "3 pastas de uma vez",
    seed: (v) => {
      v.seed("Archive");
      for (const f of ["F1", "F2", "F3"]) {
        v.seed(f);
        v.seed(`${f}/z`);
        for (const p of [`${f}/x.md`, `${f}/y.md`, `${f}/z/w.md`]) v.seed(p, p);
      }
    },
    act: (v) => ["F1", "F2", "F3"].forEach((f) => v.rename(f, `Archive/${f}`)),
  },
  {
    name: "cria pasta, move notas e renomeia a pasta",
    seed: (v) => {
      for (let i = 1; i <= 4; i++) v.seed(`m${i}.md`, `m ${i}`);
    },
    act: (v) => {
      v.createFolder("New");
      for (let i = 1; i <= 4; i++) v.rename(`m${i}.md`, `New/m${i}.md`);
      v.rename("New", "Renamed");
    },
  },
];

for (const scenario of scenarios) {
  let correct = 0;
  let failed = 0;
  let firstDiff = "";
  for (let run = 0; run < RUNS; run++) {
    await fs.rm(server.data.paths.vault, { recursive: true, force: true });
    await fs.mkdir(server.data.paths.vault, { recursive: true });
    const client = await createClient({ clientId: `move-${run}`, token, websocket: false });
    scenario.seed(client.vault);
    for (const line of client.vault.tree()) {
      const [p, content] = line.endsWith("/") ? [line.slice(0, -1), undefined] : line.split("=");
      const full = `${server.data.paths.vault}/${p}`;
      if (content === undefined) await fs.mkdir(full, { recursive: true });
      else await fs.writeFile(full, content);
    }
    const failedBefore = netStats.failed;
    scenario.act(client.vault);
    await waitForQuiet(netStats, 150);
    failed += netStats.failed - failedBefore;
    const expected = client.vault.tree();
    const actual = await diskTree(server.data.paths.vault);
    if (JSON.stringify(expected) === JSON.stringify(actual)) correct++;
    else firstDiff ||= `faltando [${expected.filter((x) => !actual.includes(x))}] sobrando [${actual.filter((x) => !expected.includes(x))}]`;
  }
  await checks.check(`${scenario.name}: vault do servidor igual ao do cliente`, () => {
    if (correct !== RUNS) throw new Error(`${correct}/${RUNS}; 1a diferenca: ${firstDiff}`);
  });
  await checks.check(`${scenario.name}: nenhuma requisicao falhou`, () => {
    if (failed) throw new Error(`${failed} falhas; backend: ${[...new Set(logs.backendErrors)].slice(0, 2).join(" | ").replaceAll(server.data.root, "<tmp>")}`);
  });
}

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
