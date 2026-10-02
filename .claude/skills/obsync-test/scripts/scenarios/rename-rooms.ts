// Renaming a folder while notes inside it are open in Yjs rooms: the rooms under the old path
// must be closed like on delete, nested files and Yjs state move, nobody can keep writing to
// the old path, the new path keeps the history, and the old name can be reused afterwards.
import fs from "node:fs/promises";
import { captureLogs, sleep } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { diskTree } from "../lib/fake-vault.ts";
import { createChecks } from "../lib/check.ts";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const logs = captureLogs();
const server = await startBackend({ websockets: true });
const alice = await server.createUser(0);
const bob = await server.createUser(1);
const checks = createChecks("rename-rooms", logs.out);
const { vault, yjsState } = server.data.paths;

const write = async (p: string, content: string) => {
  await fs.mkdir(`${vault}/${p.slice(0, p.lastIndexOf("/"))}`, { recursive: true });
  await fs.writeFile(`${vault}/${p}`, content);
};
const read = (root: string, p: string) => fs.readFile(`${root}/${p}`, "utf8").catch(() => null);
const exists = (p: string) => fs.access(p).then(() => true, () => false);

const api = async (token: string, method: string, route: string, body: unknown) => {
  const response = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-ObSync-Client": "renamer" },
    body: JSON.stringify(body),
  });
  return response.status;
};

type Room = { path: string; doc: Y.Doc; provider: WebsocketProvider; closes: { code: number; reason: string }[] };

/** Opens a room the way the plugin does: one-use ticket in Sec-WebSocket-Protocol, no auto reconnect. */
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
  const room: Room = { path, doc, provider, closes: [] };
  provider.on("connection-close", (event: { code: number; reason: string } | null) => {
    provider.shouldConnect = false;
    room.closes.push({ code: event?.code ?? 0, reason: String(event?.reason ?? "") });
  });
  provider.connect();
  await Promise.race([
    new Promise<void>((resolve) => provider.on("sync", (synced: boolean) => synced && resolve())),
    new Promise<void>((resolve) => provider.on("connection-close", () => resolve())),
    sleep(3000),
  ]);
  return room;
}

const text = (room: Room) => room.doc.getText("codemirror").toString();
const append = (room: Room, value: string) => room.doc.getText("codemirror").insert(text(room).length, value);
const until = async (condition: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await condition()) && Date.now() < end) await sleep(20);
};

await write("pasta/nota.md", "nota");
await write("pasta/sub/funda.md", "funda");
await write("fora.md", "fora");

const aliceNota = await openRoom(alice.token, "pasta/nota.md");
const bobNota = await openRoom(bob.token, "pasta/nota.md");
const aliceFunda = await openRoom(alice.token, "pasta/sub/funda.md");
const bobFora = await openRoom(bob.token, "fora.md");

append(aliceNota, " +alice");
append(aliceFunda, " +funda");
await until(() => text(bobNota) === "nota +alice");
await until(async () => (await read(vault, "pasta/sub/funda.md")) === "funda +funda");
await checks.check("antes do rename: as salas sincronizam e persistem", async () => {
  if (text(bobNota) !== "nota +alice") throw new Error(`bob ve "${text(bobNota)}"`);
  if ((await read(vault, "pasta/sub/funda.md")) !== "funda +funda") throw new Error("funda.md nao persistiu");
});

const renameStatus = await api(alice.token, "PUT", "/api/sync/rename", { oldPath: "pasta", newPath: "pasta2" });
await until(() => aliceNota.closes.length && bobNota.closes.length && aliceFunda.closes.length);

await checks.check("rename da pasta responde 200", () => {
  if (renameStatus !== 200) throw new Error(`status ${renameStatus}`);
});
for (const room of [aliceNota, bobNota, aliceFunda]) {
  await checks.check(`sala aberta ${room.path} e fechada com 1008`, () => {
    if (room.closes[0]?.code !== 1008) throw new Error(`closes ${JSON.stringify(room.closes)}`);
  });
}
await checks.check("sala fora da pasta continua aberta", () => {
  if (bobFora.closes.length || !bobFora.provider.wsconnected) throw new Error(`closes ${JSON.stringify(bobFora.closes)}`);
});

await checks.check("vault: arquivos aninhados foram para pasta2 com as edicoes", async () => {
  const tree = (await diskTree(vault)).filter((p) => !p.endsWith("/"));
  if (await exists(`${vault}/pasta`)) throw new Error(`pasta antiga ainda existe: ${tree.join(", ")}`);
  if ((await read(vault, "pasta2/nota.md")) !== "nota +alice") throw new Error(`nota.md: ${await read(vault, "pasta2/nota.md")}`);
  if ((await read(vault, "pasta2/sub/funda.md")) !== "funda +funda") throw new Error(`funda.md: ${await read(vault, "pasta2/sub/funda.md")}`);
});
await checks.check("estado Yjs: movido para pasta2, nada sob pasta", async () => {
  if (await exists(`${yjsState}/pasta`)) throw new Error("yjs-state/pasta ainda existe");
  for (const p of ["pasta2/nota.md.yjs-state", "pasta2/sub/funda.md.yjs-state"]) {
    if (!(await exists(`${yjsState}/${p}`))) throw new Error(`falta ${p}`);
  }
});

// The closed clients keep typing locally, like an editor that has not noticed yet.
append(aliceNota, " +depois");
append(bobNota, " +depois");
await sleep(300);
await checks.check("edicoes na sala antiga nao ressuscitam a pasta antiga", async () => {
  if (await exists(`${vault}/pasta`)) throw new Error(`vault: ${(await diskTree(`${vault}/pasta`)).join(", ")}`);
  if (await exists(`${yjsState}/pasta`)) throw new Error("yjs-state/pasta voltou");
});

const reopenedOld = await openRoom(bob.token, "pasta/nota.md");
await checks.check("nova conexao ao caminho antigo e recusada", () => {
  if (reopenedOld.closes[0]?.code !== 1008) throw new Error(`closes ${JSON.stringify(reopenedOld.closes)}, texto "${text(reopenedOld)}"`);
});
const modifyOld = await api(alice.token, "PUT", "/api/sync/modify", { path: "pasta/nota.md", content: "x" });
await checks.check("modify no caminho antigo responde 409", async () => {
  if (modifyOld !== 409) throw new Error(`status ${modifyOld}`);
  if (await exists(`${vault}/pasta`)) throw new Error("modify recriou a pasta");
});

const bobNew = await openRoom(bob.token, "pasta2/nota.md");
const aliceNew = await openRoom(alice.token, "pasta2/nota.md");
await checks.check("caminho novo abre com o conteudo e o historico", () => {
  if (bobNew.closes.length || text(bobNew) !== "nota +alice") throw new Error(`"${text(bobNew)}" closes ${JSON.stringify(bobNew.closes)}`);
});
append(aliceNew, " +novo");
await until(() => text(bobNew) === "nota +alice +novo");
await until(async () => (await read(vault, "pasta2/nota.md")) === "nota +alice +novo");
await checks.check("outros clientes editam juntos no caminho novo", async () => {
  if (text(bobNew) !== "nota +alice +novo") throw new Error(`bob ve "${text(bobNew)}"`);
  if ((await read(vault, "pasta2/nota.md")) !== "nota +alice +novo") throw new Error("nao persistiu");
});

// Edit sent in the same tick as the rename: whichever wins, the old folder must not come back.
const raceRoom = await openRoom(alice.token, "pasta2/sub/funda.md");
append(raceRoom, " +corrida");
const raceStatus = await api(alice.token, "PUT", "/api/sync/rename", { oldPath: "pasta2", newPath: "pasta3" });
await until(() => bobNew.closes.length && aliceNew.closes.length && raceRoom.closes.length);
await sleep(300);
const raceText = await read(vault, "pasta3/sub/funda.md");
await checks.check("edicao no mesmo instante do rename: pasta2 nao volta", async () => {
  if (raceStatus !== 200) throw new Error(`status ${raceStatus}`);
  if (await exists(`${vault}/pasta2`)) throw new Error(`vault: ${(await diskTree(`${vault}/pasta2`)).join(", ")}`);
  if (await exists(`${yjsState}/pasta2`)) throw new Error("yjs-state/pasta2 voltou");
});

// Renaming back onto a name used before must make it usable again.
const backStatus = await api(alice.token, "PUT", "/api/sync/rename", { oldPath: "pasta3", newPath: "pasta" });
const backRoom = await openRoom(bob.token, "pasta/nota.md");
await checks.check("renomear de volta para o nome antigo: a sala abre", () => {
  if (backStatus !== 200) throw new Error(`rename status ${backStatus}`);
  if (backRoom.closes.length) throw new Error(`recusada: ${JSON.stringify(backRoom.closes)}`);
  if (text(backRoom) !== "nota +alice +novo") throw new Error(`texto "${text(backRoom)}"`);
});
const modifyBack = await api(alice.token, "PUT", "/api/sync/modify", { path: "pasta/nota.md", content: "reusado" });
await checks.check("renomear de volta para o nome antigo: modify aceito", () => {
  if (modifyBack !== 200) throw new Error(`status ${modifyBack}`);
});

const fileRename = await api(alice.token, "PUT", "/api/sync/rename", { oldPath: "fora.md", newPath: "pasta/fora.md" });
await until(() => bobFora.closes.length);
await checks.check("rename de nota aberta (arquivo) fecha a sala dela", () => {
  if (fileRename !== 200) throw new Error(`status ${fileRename}`);
  if (bobFora.closes[0]?.code !== 1008) throw new Error(`closes ${JSON.stringify(bobFora.closes)}`);
});

await checks.check("sem erro no log do backend", () => {
  if (logs.backendErrors.length) throw new Error(logs.backendErrors.slice(0, 3).join(" | "));
});

const code = checks.finish([`  info edicao concorrente ao rename ficou em pasta3: ${JSON.stringify(raceText)}`]);
for (const room of [aliceNota, bobNota, aliceFunda, bobFora, reopenedOld, bobNew, aliceNew, raceRoom, backRoom]) {
  room.provider.destroy();
}
await sleep(200);
await server.data.cleanup();
process.exit(code);
