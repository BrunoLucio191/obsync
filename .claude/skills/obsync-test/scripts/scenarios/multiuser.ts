// Several admin clients changing the vault at once, each only inside its own `user-N/` folder.
// Each client is randomly "conectado" (/system WebSocket the whole time), "instavel" (drops the
// socket for a while and reconnects) or "sozinho" (no WebSocket, only publishes).
// Usage: multiuser.ts [--users 5] [--seed 1] [--ops 60]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { monitorEventLoopDelay } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { captureLogs, fakeObsidian, sleep } from "../lib/env.ts";
import { activity, diskTree, waitForQuiet } from "../lib/fake-vault.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { createChecks } from "../lib/check.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const USERS = arg("users", 5);
const SEED = arg("seed", 1);
const OPS = arg("ops", 60);

const logs = captureLogs();
const { netStats, TFile, TFolder } = await fakeObsidian();

// ---- seeded randomness, so a failing seed can be replayed
let state = SEED;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(items: T[]): T | undefined => items[Math.floor(rand() * items.length)];
const text = (min: number, max: number) => {
  const size = min + Math.floor(rand() * (max - min));
  let s = "";
  while (s.length < size) s += Math.floor(rand() * 1e9).toString(36) + " ";
  return s.slice(0, size);
};

// ---- server in its own process
const child = spawn(process.execPath, [path.join(import.meta.dirname, "server-process.ts"), String(USERS)], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
const info = JSON.parse((await lines.next()).value);
const plugin = await loadPlugin(info.baseUrl);

// every non-GET request outside the sender's own folder is an echo of someone else's change
const echoes: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any) => {
  const clientId: string | undefined = init?.headers?.["X-ObSync-Client"];
  if (clientId && init.method !== "GET" && !String(url).includes("/api/auth/")) {
    const root = `user-${clientId.split("-")[1]}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const touched = [init.headers["X-ObSync-filePath"], body.path, body.oldPath, body.newPath].filter(Boolean);
    for (const p of touched) if (p !== root && !p.startsWith(`${root}/`)) echoes.push(`${clientId} -> ${p}`);
  }
  return realFetch(url, init);
}) as typeof fetch;

type Profile = "conectado" | "instavel" | "sozinho";
const profiles: Profile[] = Array.from({ length: USERS }, () => {
  const r = rand();
  return r < 0.5 ? "conectado" : r < 0.7 ? "instavel" : "sozinho";
});
if (!profiles.includes("conectado")) profiles[0] = "conectado";
if (!profiles.includes("sozinho")) profiles[USERS - 1] = "sozinho";

const clients = await Promise.all(
  profiles.map(async (profile, i) => {
    const token = info.tokens[i];
    const client = await createClient({
      clientId: `client-${i}`,
      token,
      websocket: profile !== "sozinho",
      issueTicket: async () => {
        const response = await realFetch(`${info.baseUrl}/api/auth/ws-ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ channel: "system" }),
        });
        return response.ok ? (await response.json()).ticket : null;
      },
    });
    return { ...client, i, profile, root: `user-${i}`, offlineMs: 0 };
  }),
);
for (const c of clients) c.channel?.connect();
await sleep(300);

// ---- random user activity
const opCounts: Record<string, number> = {};
async function act(c: (typeof clients)[number]) {
  const v = c.vault;
  const own = () => [...v.entries.keys()].filter((p) => p === c.root || p.startsWith(`${c.root}/`));
  const folders = () => own().filter((p) => v.entries.get(p) instanceof TFolder);
  const files = () => own().filter((p) => v.entries.get(p) instanceof TFile);
  const dropAt = c.profile === "instavel" ? Math.floor(OPS * (0.3 + rand() * 0.3)) : -1;
  let n = 0;
  v.createFolder(c.root);
  for (let step = 0; step < OPS; step++) {
    if (step === dropAt) {
      c.channel!.disconnect();
      c.offlineMs = 300 + Math.floor(rand() * 1200);
      setTimeout(() => c.channel!.connect(), c.offlineMs);
    }
    const r = rand();
    const folder = pick(folders())!;
    const subfolders = folders().filter((p) => p !== c.root);
    const file = pick(files());
    const notes = files().filter((p) => p.endsWith(".md"));
    let op: string;
    if (r < 0.22) {
      op = "criar nota";
      v.createFile(`${folder}/note-${n++}.md`, text(100, 4000));
    } else if (r < 0.5 && notes.length) {
      op = "editar nota";
      v.modify(pick(notes)!, text(100, 4000));
    } else if (r < 0.58) {
      op = "subir binario";
      v.createFile(`${folder}/bin-${n++}.${pick(["png", "mp3", "pdf"])}`, text(5000, 60000));
    } else if (r < 0.66 && file) {
      op = "renomear arquivo";
      v.rename(file, `${file.slice(0, file.lastIndexOf("/"))}/renamed-${n++}${file.slice(file.lastIndexOf("."))}`);
    } else if (r < 0.74 && file) {
      op = "mover arquivo";
      const target = pick(folders().filter((f) => f !== file.slice(0, file.lastIndexOf("/"))));
      if (!target) continue;
      v.rename(file, `${target}/${file.slice(file.lastIndexOf("/") + 1)}`);
    } else if (r < 0.8) {
      op = "criar pasta";
      v.createFolder(`${folder}/dir-${n++}`);
    } else if (r < 0.86 && subfolders.length) {
      op = "renomear pasta";
      const target = pick(subfolders)!;
      v.rename(target, `${target.slice(0, target.lastIndexOf("/"))}/dir-${n++}`);
    } else if (r < 0.95 && file) {
      op = "apagar arquivo";
      v.delete(file);
    } else if (subfolders.length) {
      op = "apagar pasta";
      v.delete(pick(subfolders)!);
    } else continue;
    opCounts[op] = (opCounts[op] ?? 0) + 1;
    await sleep(Math.floor(rand() * 60));
  }
}

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const started = performance.now();
await Promise.all(clients.map(act));
await waitForQuiet(netStats, 800);
const elapsed = (performance.now() - started - 800) / 1000;
loop.disable();

// the Gene watcher is still catching up with the last writes
let gene = "";
for (let stable = 0; stable < 8; ) {
  const current = await fs.readFile(info.gene, "utf8").catch(() => "");
  stable = current === gene ? stable + 1 : 0;
  gene = current;
  await sleep(100);
}

child.stdin!.write("stop\n");
const stats = JSON.parse((await lines.next()).value);
await new Promise((r) => child.once("exit", r));

// ---- verification against the server's vault on disk
const server = await diskTree(info.vault);
const checks = createChecks(`multiuser ${USERS} usuarios seed ${SEED}`, logs.out);
const details: string[] = [];
const names = (tree: string[]) => tree.map((x) => x.split("=")[0]);

for (const c of clients) {
  const local = c.vault.tree(c.root);
  const remote = server.filter((x) => x.startsWith(`${c.root}/`));
  await checks.check(`${c.clientId} (${c.profile}): pasta propria igual a do servidor`, () => {
    if (JSON.stringify(local) === JSON.stringify(remote)) return;
    const onlyLocal = names(local).filter((x) => !names(remote).includes(x));
    const onlyServer = names(remote).filter((x) => !names(local).includes(x));
    const content = names(local).filter((x, k) => names(remote).includes(x) && !remote.includes(local[k]));
    throw new Error(`so no cliente [${onlyLocal}] so no servidor [${onlyServer}] conteudo diferente [${content}]`);
  });
  if (c.profile === "sozinho") continue;
  const whole = c.vault.tree();
  const missing = server.filter((x) => !whole.includes(x)).length;
  const extra = whole.filter((x) => !server.includes(x)).length;
  if (c.profile === "conectado") {
    await checks.check(`${c.clientId} (conectado): vault inteiro igual ao servidor`, () => {
      if (missing || extra) throw new Error(`${missing} faltando, ${extra} sobrando`);
    });
  } else if (missing || extra) {
    details.push(`  info ${c.clientId} ficou ${c.offlineMs}ms offline e perdeu eventos: ${missing} faltando, ${extra} sobrando (sem ressincronizacao ao reconectar)`);
  }
}
await checks.check("nenhum cliente republicou mudanca de outro usuario (eco)", () => {
  if (echoes.length) throw new Error(`${echoes.length}: ${echoes.slice(0, 3).join("; ")}`);
});
await checks.check("nenhuma requisicao falhou", () => {
  if (netStats.failed) throw new Error(`${netStats.failed} falhas; backend: ${[...new Set(stats.backendErrors.map((e: string) => e.replace(info.root, "<tmp>").slice(0, 110)))].slice(0, 3).join(" | ")}`);
});
await checks.check("todo evento publicado leva originClientId", () => {
  const missing = stats.published.filter((e: { origin?: string }) => !e.origin);
  if (missing.length) throw new Error(`${missing.length} de ${stats.published.length} sem origem (${[...new Set(missing.map((e: { type: string }) => e.type))]}) voltam para quem enviou`);
});
await checks.check("servidor sem rejeicoes nao tratadas", () => {
  if (stats.unhandled.length) throw new Error(`${stats.unhandled.length}: ${stats.unhandled[0].replace(info.root, "<tmp>")}`);
});
await checks.check("gene.json bate com o vault final", () => {
  const parsed = JSON.parse(gene);
  const files = server.filter((x) => !x.endsWith("/")).map((x) => x.slice(x.indexOf("=") + 1));
  const bytes = files.reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  const count = files.filter((content) => content.length > 0).length;
  if (parsed.bytes !== bytes || parsed.filesCount !== count) {
    throw new Error(`gene ${parsed.filesCount} arquivos/${parsed.bytes} bytes, vault ${count}/${bytes}`);
  }
});

const sorted = [...netStats.latencies].sort((a: number, b: number) => a - b);
const pct = (p: number) => (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(1);
const clientErrors = [...logs.pluginErrors, ...activity.handlerErrors];
const code = checks.finish([
  ...details,
  `  perfis ${profiles.join(",")} | ${Object.values(opCounts).reduce((a, b) => a + b, 0)} acoes em ${elapsed.toFixed(1)}s | ${netStats.requests} requisicoes, latencia p50 ${pct(0.5)}ms p95 ${pct(0.95)}ms max ${pct(1)}ms`,
  `  event loop max: servidor ${stats.loopMaxMs.toFixed(0)}ms (p99 ${stats.loopP99Ms.toFixed(0)}) | clientes ${(loop.max / 1e6).toFixed(0)}ms (p99 ${(loop.percentile(99) / 1e6).toFixed(0)})`,
  `  erros: backend ${stats.backendErrors.length}${stats.backendErrors.length ? ` (ex: ${[...new Set(stats.backendErrors.map((e: string) => e.replaceAll(info.root, "<tmp>").slice(0, 110)))].slice(0, 2).join(" | ")})` : ""}, plugin ${clientErrors.length}${clientErrors.length ? ` (ex: ${[...new Set(clientErrors.map((e) => e.slice(0, 90)))].slice(0, 2).join(" | ")})` : ""}`,
]);
await fs.rm(info.root, { recursive: true, force: true });
process.exit(code);
