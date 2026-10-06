// Deleting a note (or its folder) while someone is typing in it: a Yjs flush that already passed
// the isPathDeleted() check must not write the .md or the .yjs-state back after the delete.
// Each run types into a fresh note and deletes it at a random moment (`--runs`, default 30).
import fs from "node:fs/promises";
import { captureLogs, sleep } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createChecks } from "../lib/check.ts";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const runsIndex = process.argv.indexOf("--runs");
const RUNS = runsIndex === -1 ? 30 : Number(process.argv[runsIndex + 1]);
// Milliseconds between keystrokes; 1 is a stress test, ~100 is someone typing.
const intervalIndex = process.argv.indexOf("--interval");
const INTERVAL = intervalIndex === -1 ? 1 : Number(process.argv[intervalIndex + 1]);

const logs = captureLogs();
const server = await startBackend({ websockets: true });
const alice = await server.createUser(0);
const bob = await server.createUser(1);
const checks = createChecks("delete-race", logs.out);
const { vault, yjsState } = server.data.paths;

const exists = (p: string) => fs.access(p).then(() => true, () => false);

type Room = { doc: Y.Doc; provider: WebsocketProvider; closed: boolean };

async function openRoom(token: string, path: string): Promise<Room> {
  const ticketResponse = await fetch(`${server.baseUrl}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-ObSync-Client": "yjs" },
    body: JSON.stringify({ channel: "yjs" }),
  });
  const { ticket } = await ticketResponse.json();
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${server.port}`, encodeURIComponent(path), doc, {
    connect: false,
    protocols: [`obsync-ticket.${ticket}`],
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  });
  const room: Room = { doc, provider, closed: false };
  provider.on("connection-close", () => {
    provider.shouldConnect = false;
    room.closed = true;
  });
  provider.connect();
  await Promise.race([
    new Promise<void>((resolve) => provider.on("sync", (synced: boolean) => synced && resolve())),
    sleep(3000),
  ]);
  return room;
}

type Result = { kind: "file" | "folder"; md: boolean; state: boolean; status: number };
const results: Result[] = [];

for (let i = 0; i < RUNS; i++) {
  const kind = i % 2 === 0 ? "folder" : "file";
  const folder = `pasta-${i}`;
  const note = `${folder}/nota.md`;
  await fs.mkdir(`${vault}/${folder}`, { recursive: true });
  await fs.writeFile(`${vault}/${note}`, "inicio");

  const room = await openRoom(alice.token, note);
  const text = room.doc.getText("codemirror");

  // Types one character every INTERVAL ms until the server closes the room.
  const typing = (async () => {
    while (!room.closed) {
      text.insert(text.length, "x");
      await sleep(INTERVAL);
    }
  })();

  await sleep(50 + Math.random() * Math.max(100, INTERVAL * 3));
  const response = await fetch(`${server.baseUrl}/api/sync/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bob.token}`, "X-ObSync-Client": "deleter" },
    body: JSON.stringify({ path: kind === "folder" ? folder : note, isFolder: kind === "folder" }),
  });
  await typing;
  await sleep(200);

  results.push({
    kind,
    status: response.status,
    md: await exists(`${vault}/${note}`),
    state: await exists(`${yjsState}/${note}.yjs-state`),
  });
  room.provider.destroy();
}

const hits = results.filter((r) => r.status === 200 && (r.md || r.state));
const summary = (kind: Result["kind"]) => {
  const all = results.filter((r) => r.kind === kind && r.status === 200);
  const md = all.filter((r) => r.md).length;
  const state = all.filter((r) => r.state).length;
  return `  info ${kind}: ${all.length} deletes com 200, .md voltou em ${md}, .yjs-state voltou em ${state}`;
};

await checks.check("todos os deletes respondem 200", () => {
  const bad = results.filter((r) => r.status !== 200);
  if (bad.length) throw new Error(`status ${bad.map((r) => r.status).join(", ")}`);
});
await checks.check("nenhum delete e desfeito por um flush em andamento", () => {
  if (hits.length) throw new Error(`${hits.length}/${results.length} deletes desfeitos`);
});

const errors = [...new Set(logs.backendErrors.map((e) => e.slice(0, 160)))].slice(0, 3);
const code = checks.finish([summary("folder"), summary("file"), ...errors.map((e) => `  info erro: ${e}`)]);
await sleep(200);
await server.data.cleanup();
process.exit(code);
