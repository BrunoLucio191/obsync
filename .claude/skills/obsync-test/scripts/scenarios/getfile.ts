// Binary files: getFile only serves files inside the vault (404 for anything else, including
// paths that try to leave it), createFile events carry originClientId, and a client that
// missed a binary (renamed before it could download it) recovers it from the next rename.
import fs from "node:fs/promises";
import { backend, captureLogs, fakeObsidian } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
await fakeObsidian();
const server = await startBackend();
await loadPlugin(server.baseUrl);
const { vaultEvents } = await backend("syncEvents.ts");
const admin = await server.createUser(0);
const regular = await server.createUser(1, "user");
const checks = createChecks("getfile", logs.out);
const vault = server.data.paths.vault;

const write = async (p: string, content: string) => {
  await fs.mkdir(`${vault}/${p.slice(0, p.lastIndexOf("/"))}`, { recursive: true });
  await fs.writeFile(`${vault}/${p}`, content);
};
const getFile = async (p: string) => {
  const params = new URLSearchParams({ path: p, fileName: p.slice(p.lastIndexOf("/") + 1) });
  const response = await fetch(`${server.baseUrl}/api/sync/getFile?${params}`, {
    headers: { Authorization: `Bearer ${regular.token}`, "X-ObSync-Client": "reader" },
  });
  return { status: response.status, body: await response.text() };
};

await write("pics/a.png", "AAA");
await checks.check("arquivo do vault: 200 com o conteudo", async () => {
  const r = await getFile("pics/a.png");
  if (r.status !== 200 || r.body !== "AAA") throw new Error(`status ${r.status}`);
});
for (const [label, p] of [
  ["arquivo que nao existe", "pics/none.png"],
  ["pasta", "pics"],
  ["fora do vault (../users.sqlite)", "../users.sqlite"],
  ["caminho absoluto", server.data.paths.usersDatabase],
]) {
  await checks.check(`${label}: 404`, async () => {
    const r = await getFile(p);
    if (r.status !== 404) throw new Error(`status ${r.status}, ${r.body.length} bytes`);
  });
}
await checks.check("404 de arquivo sumido nao vira erro no log do backend", () => {
  if (logs.backendErrors.length) throw new Error(logs.backendErrors[0]);
});

const events: { originClientId?: string }[] = [];
vaultEvents.on("change", (change: { originClientId?: string }) => events.push(change));
const upload = await fetch(`${server.baseUrl}/api/sync/createFile`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${admin.token}`,
    "X-ObSync-Client": "uploader",
    "Content-Type": "application/octet-stream",
    "X-ObSync-filePath": "up/bin.pdf",
  },
  body: "PDFDATA",
});
await checks.check("createFile publica o evento com originClientId", () => {
  if (upload.status !== 200 || events.at(-1)?.originClientId !== "uploader") {
    throw new Error(`status ${upload.status}, evento ${JSON.stringify(events.at(-1))}`);
  }
});

// a client that receives the events after the owner already moved things on the server
const client = await createClient({ clientId: "late", token: admin.token, websocket: false });
const has = (p: string) => client.vault.entries.has(p);
const binary = (path: string) => ({ type: "create", path, isFolder: false, isBinary: true });

await write("pics/c.png", "CCC"); // b.png was renamed to c.png before the client downloaded it
await client.remote.apply(binary("pics/b.png"));
await client.remote.apply({ type: "rename", oldPath: "pics/b.png", newPath: "pics/c.png" });
await checks.check("binario perdido e baixado no caminho do rename", () => {
  if (has("pics/b.png") || client.vault.contents.get("pics/c.png") !== "CCC") throw new Error(client.vault.tree().join(","));
});

await write("moved/d.png", "DDD"); // folder pics2 was renamed to moved
await client.remote.apply(binary("pics2/d.png"));
await client.remote.apply({ type: "rename", oldPath: "pics2", newPath: "moved" });
await checks.check("binario perdido e baixado quando a pasta acima e renomeada", () => {
  if (client.vault.contents.get("moved/d.png") !== "DDD") throw new Error(client.vault.tree().join(","));
});

await write("y/e.png", "EEE");
await client.remote.apply(binary("x/e.png"));
await client.remote.apply({ type: "delete", path: "x", isFolder: true });
await client.remote.apply({ type: "rename", oldPath: "x/e.png", newPath: "y/e.png" });
await checks.check("delete esquece o binario perdido", () => {
  if (has("y/e.png")) throw new Error("baixou um arquivo que ja tinha sido apagado");
});

await checks.check("nenhum erro no plugin durante a recuperacao", () => {
  if (logs.pluginErrors.length) throw new Error(logs.pluginErrors[0]);
});

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
