// A regular user never publishes, so their copy of the vault drifts from the server's. Changes
// the admin makes afterwards must still reach them without losing their private edits:
// renames of things they moved fetch the server's result, text is merged three-way with
// git-style markers on conflict, and binaries they changed get a "(server version)" copy.
import fs from "node:fs/promises";
import { captureLogs, fakeObsidian, sleep } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { waitForQuiet } from "../lib/fake-vault.ts";
import { installZipWorker } from "../lib/zip-worker.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
const { netStats, notices } = await fakeObsidian();
installZipWorker();
const server = await startBackend({ websockets: true });
await loadPlugin(server.baseUrl);
const admin = await server.createUser(0, "admin");
const regular = await server.createUser(1, "user");
const checks = createChecks("readonly-user", logs.out);

// same start on the server and on both clients, except notes/keep.md which the user
// changed before any merge base existed
const start: [string, string?][] = [
  ["notes"],
  ["notes/a.md", "A"],
  ["notes/keep.md", "orig"],
  ["pics"],
  ["pics/img.png", "IMG"],
  ["pics/other.png", "OTHER"],
  ["docs"],
  ["docs/d.md", "D"],
  ["archive"],
  ["archive/x.md", "X"],
  ["archive/sub"],
  ["archive/sub/y.md", "Y"],
];
for (const [p, content] of start) {
  const full = `${server.data.paths.vault}/${p}`;
  if (content === undefined) await fs.mkdir(full, { recursive: true });
  else await fs.writeFile(full, content);
}
const adminClient = await createClient({ clientId: "admin", token: admin.token, websocket: false });
const user = await createClient({
  clientId: "user",
  token: regular.token,
  websocket: true,
  role: "user",
  issueTicket: async () => {
    const response = await fetch(`${server.baseUrl}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${regular.token}` },
      body: JSON.stringify({ channel: "system" }),
    });
    return response.ok ? (await response.json()).ticket : null;
  },
});
for (const [p, content] of start) {
  adminClient.vault.seed(p, content);
  user.vault.seed(p, p === "notes/keep.md" ? "user edit" : content);
}
user.channel.connect();
await sleep(300);

const settle = () => waitForQuiet(netStats, 300);
const read = (p: string) => user.vault.contents.get(p);
const has = (p: string) => user.vault.entries.has(p);
const tree = () => user.vault.tree().map((x) => x.split("=")[0]).join(" ");
const newNotices = () => {
  const start = notices.length;
  return () => notices.slice(start);
};
async function initialSyncDone(since: () => string[]) {
  for (let i = 0; i < 200 && !since().includes("Initial synchronization complete."); i++) await sleep(25);
  await settle();
}

// ---- renames of things the user already moved
adminClient.vault.rename("notes/a.md", "notes/b.md");
await settle();
await checks.check("controle: sem reorganizar, o rename do admin chega", () => {
  if (!has("notes/b.md") || has("notes/a.md")) throw new Error(tree());
});

user.vault.rename("pics", "my-images");
user.vault.rename("docs/d.md", "d.md");
await settle();
let since = newNotices();
adminClient.vault.rename("pics/img.png", "img.png");
adminClient.vault.rename("docs/d.md", "docs/moved.md");
await settle();
await checks.check("imagem que o usuario moveu (sem base) e o admin mandou para a raiz: baixada em img.png, com aviso", () => {
  if (read("img.png") !== "IMG" || !has("my-images/img.png")) throw new Error(tree());
  if (!since().some((n) => n.includes("pics/img.png") && n.includes("no longer gets updates"))) throw new Error(`avisos: ${since()}`);
});
await checks.check("nota que o usuario tirou da pasta e o admin renomeou: baixada em docs/moved.md", () => {
  if (read("docs/moved.md") !== "D" || !has("d.md")) throw new Error(tree());
});

user.vault.rename("archive", "my-archive");
await settle();
since = newNotices();
adminClient.vault.rename("archive", "old");
await settle();
await initialSyncDone(since);
await checks.check("pasta que o usuario renomeou e o admin tambem: initialSync traz old/, com aviso", () => {
  if (user.fullSyncs !== 1) throw new Error(`${user.fullSyncs} syncs completos`);
  if (read("old/x.md") !== "X" || read("old/sub/y.md") !== "Y" || !has("my-archive/x.md")) throw new Error(tree());
  if (!since().some((n) => n.startsWith("The admin moved archive to old"))) throw new Error(`avisos: ${since()}`);
});

// files the user received (so they have a base) and then moved locally
adminClient.vault.createFile("photos/cat.png", "CAT");
adminClient.vault.createFile("notes/n.md", "N");
adminClient.vault.createFile("a/dup.md", "SAME");
adminClient.vault.createFile("b/dup.md", "SAME");
await settle();
user.vault.rename("photos/cat.png", "my-photos/cat.png");
user.vault.rename("notes/n.md", "mine/n.md");
user.vault.modify("mine/n.md", "N user");
user.vault.rename("b/dup.md", "c/dup.md");
await settle();
since = newNotices();
adminClient.vault.rename("photos/cat.png", "gallery/cat.png");
await settle();
await checks.check("usuario so moveu (sem editar): a copia dele vai para o lugar novo, sem duplicar", () => {
  if (read("gallery/cat.png") !== "CAT" || has("my-photos/cat.png")) throw new Error(tree());
  if (!since().some((n) => n.includes("my-photos/cat.png") && n.includes("moved there too"))) throw new Error(`avisos: ${since()}`);
});
adminClient.vault.rename("notes/n.md", "notes2/n.md");
await settle();
await checks.check("usuario moveu e editou: baixa a do servidor e mantem a dele", () => {
  if (read("notes2/n.md") !== "N" || read("mine/n.md") !== "N user") throw new Error(tree());
});
adminClient.vault.rename("b/dup.md", "d/dup.md");
await settle();
await checks.check("arquivo igual que existe no servidor (a/dup.md) nao e confundido com a copia do usuario", () => {
  if (read("a/dup.md") !== "SAME" || read("d/dup.md") !== "SAME" || has("c/dup.md")) throw new Error(tree());
});

// ---- text
adminClient.vault.createFile("ff.md", "l1\nl2\nl3");
adminClient.vault.createFile("m.md", "a\nb\nc\nd\ne");
adminClient.vault.createFile("c.md", "x\ny\nz");
await settle();
adminClient.vault.modify("ff.md", "l1\nl2 admin\nl3");
await settle();
await checks.check("texto que o usuario nao mexeu: recebe a versao nova", () => {
  if (read("ff.md") !== "l1\nl2 admin\nl3") throw new Error(JSON.stringify(read("ff.md")));
});

user.vault.modify("m.md", "a user\nb\nc\nd\ne");
await settle();
adminClient.vault.modify("m.md", "a\nb\nc\nd\ne admin");
await settle();
await checks.check("usuario e admin mudam linhas diferentes: merge sem marcadores", () => {
  if (read("m.md") !== "a user\nb\nc\nd\ne admin") throw new Error(JSON.stringify(read("m.md")));
});

user.vault.modify("c.md", "x\ny user\nz");
await settle();
since = newNotices();
adminClient.vault.modify("c.md", "x\ny admin\nz");
await settle();
await checks.check("usuario e admin mudam a mesma linha: marcadores de conflito estilo git e aviso", () => {
  const expected = "x\n<<<<<<< your version\ny user\n=======\ny admin\n>>>>>>> server version\nz";
  if (read("c.md") !== expected) throw new Error(JSON.stringify(read("c.md")));
  if (!since().some((n) => n.includes("c.md"))) throw new Error(`avisos: ${since()}`);
});

adminClient.vault.modify("notes/keep.md", "admin edit");
await settle();
await checks.check("arquivo mudado pelo usuario antes de existir base: mantido como esta", () => {
  if (read("notes/keep.md") !== "user edit") throw new Error(JSON.stringify(read("notes/keep.md")));
});

// ---- binaries (a replaced binary arrives as a modify event on the admin's side)
adminClient.vault.createFile("pic.png", "PIC1");
adminClient.vault.createFile("pic2.png", "P1");
await settle();
adminClient.vault.modify("pic.png", "PIC2");
await settle();
await checks.check("binario que o usuario nao mexeu: recebe a versao nova (e o servidor guarda os bytes)", async () => {
  const onServer = await fs.readFile(`${server.data.paths.vault}/pic.png`, "utf8");
  if (read("pic.png") !== "PIC2" || onServer !== "PIC2") throw new Error(`usuario ${read("pic.png")}, servidor ${onServer}`);
});

user.vault.modify("pic2.png", "USERPIC");
await settle();
since = newNotices();
adminClient.vault.modify("pic2.png", "P2");
await settle();
await checks.check("binario que o usuario mudou: mantem o dele e grava 'pic2 (server version).png'", () => {
  if (read("pic2.png") !== "USERPIC" || read("pic2 (server version).png") !== "P2") throw new Error(tree());
  if (!since().some((n) => n.includes("pic2 (server version).png"))) throw new Error(`avisos: ${since()}`);
});

// ---- changes made while the user was offline arrive through the initial sync
adminClient.vault.createFile("off.md", "1\n2\n3");
await settle();
user.channel.disconnect();
user.vault.modify("off.md", "1 user\n2\n3");
adminClient.vault.modify("off.md", "1\n2\n3 admin");
await settle();
// the Gene watcher is off in this process, so bump the gene the way it would
await fs.writeFile(server.data.paths.vaultGene, JSON.stringify({ generation: 99, bytes: 0, filesCount: 0, lastModification: "offline" }));
since = newNotices();
await user.initialSync.sync();
await initialSyncDone(since);
await checks.check("mudanca feita enquanto o usuario estava offline: initialSync faz o merge", () => {
  if (read("off.md") !== "1 user\n2\n3 admin") throw new Error(JSON.stringify(read("off.md")));
});

const errors = [...logs.pluginErrors, ...logs.backendErrors];
await checks.check("sem erros no plugin nem no backend", () => {
  if (errors.length) throw new Error([...new Set(errors.map((e) => e.slice(0, 140)))].slice(0, 3).join(" | "));
});

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
