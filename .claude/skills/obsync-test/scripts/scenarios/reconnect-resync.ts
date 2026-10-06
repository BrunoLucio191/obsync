// What SystemChannel does when /system drops for real (server-side close): does the client
// resync on reconnect, does a deliberate connect() look like a drop, and does the backoff
// start over after a successful reconnect.
import { captureLogs, fakeObsidian, sleep } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { waitForQuiet } from "../lib/fake-vault.ts";
import { installZipWorker } from "../lib/zip-worker.ts";
import { createChecks } from "../lib/check.ts";
import { openedModals } from "../lib/fake-obsidian.ts";

const logs = captureLogs();
const { netStats } = await fakeObsidian();
installZipWorker();
const server = await startBackend({ websockets: true });
await loadPlugin(server.baseUrl);
const checks = createChecks("reconnect-resync", logs.out);
const info: string[] = [];

const aliceUser = await server.createUser(0);
const bobUser = await server.createUser(1);
const alice = await createClient({
  clientId: "alice",
  token: aliceUser.token,
  websocket: true,
  issueTicket: async () => {
    const response = await fetch(`${server.baseUrl}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceUser.token}` },
      body: JSON.stringify({ channel: "system" }),
    });
    return response.ok ? (await response.json()).ticket : null;
  },
});
const bob = await createClient({ clientId: "bob", token: bobUser.token, websocket: false });

let syncs = 0;
const originalSync = alice.initialSync.sync.bind(alice.initialSync);
alice.initialSync.sync = async () => {
  syncs++;
  return originalSync();
};

const systemSockets = (): Set<{ terminate(): void }> => server.webSockets.wssSystem.clients;
const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await sleep(10);
  return condition();
};
/** Kills alice's socket from the server, like a network drop, and returns ms until she is back. */
const drop = async () => {
  for (const socket of systemSockets()) socket.terminate();
  await until(() => systemSockets().size === 0, 2000);
  const start = Date.now();
  const back = await until(() => systemSockets().size === 1, 40_000);
  return back ? Date.now() - start : Infinity;
};
const has = (path: string) => alice.vault.entries.has(path);

alice.channel.connect();
await until(() => systemSockets().size === 1);
bob.vault.createFile("antes.md", "antes");
await waitForQuiet(netStats);
await until(() => has("antes.md"), 2000);
await checks.check("conectada: recebe evento ao vivo, sem resync", () => {
  if (!has("antes.md")) throw new Error("antes.md nao chegou");
  if (syncs || openedModals.length) throw new Error(`syncs ${syncs}, modais ${openedModals.length}`);
});

// 1. Real drop; bob changes the vault while alice is offline, then nothing else happens.
for (const socket of systemSockets()) socket.terminate();
bob.vault.createFile("perdida.md", "perdida");
await waitForQuiet(netStats);
await until(() => systemSockets().size === 1);
await sleep(1500);
const syncsAfterReconnect = syncs;
await checks.check("queda real: resync roda ao reconectar, sem esperar outro evento", () => {
  if (syncsAfterReconnect === 0) throw new Error(`0 syncs 1.5s apos reconectar; perdida.md no vault: ${has("perdida.md")}`);
  if (!has("perdida.md")) throw new Error("sync rodou mas perdida.md nao chegou");
});

// 2. The next event from someone else is what finally triggers it.
bob.vault.createFile("gatilho.md", "gatilho");
await waitForQuiet(netStats);
await until(() => has("perdida.md"), 3000);
info.push(`  info depois do proximo evento: syncs ${syncs}, modais ${openedModals.length}, perdida.md chegou: ${has("perdida.md")}`);

// 3. Deliberate reconnect (what #handleSessionChanged does) must not look like a drop.
await waitForQuiet(netStats);
const syncsBefore = syncs;
const modalsBefore = openedModals.length;
alice.channel.connect();
await until(() => systemSockets().size === 1);
bob.vault.createFile("depois-do-connect.md", "x");
await waitForQuiet(netStats);
await sleep(300);
await checks.check("connect() de proposito nao abre modal nem resync", () => {
  const extra = syncs - syncsBefore;
  const modals = openedModals.length - modalsBefore;
  if (extra || modals) throw new Error(`${extra} syncs e ${modals} modais depois de um connect() deliberado`);
});

// 4. Backoff: each successful reconnect should start over from the base delay.
const delays: number[] = [];
for (let i = 0; i < 5; i++) {
  delays.push(await drop());
  await sleep(200);
}
info.push(`  info espera para reconectar em quedas seguidas (ms): ${delays.join(", ")}`);
await checks.check("backoff volta ao inicio depois de reconectar", () => {
  if (Math.max(...delays) > 1500) throw new Error(`esperas ${delays.join(", ")} ms`);
});

await checks.check("sem erro no log do backend", () => {
  if (logs.backendErrors.length) throw new Error(logs.backendErrors.slice(0, 3).join(" | "));
});

const code = checks.finish(info);
alice.channel.disconnect();
await sleep(200);
await server.data.cleanup();
process.exit(code);
