// Child process for multiuser.ts: the full backend (auth, WebSocket, Yjs persistence, Gene
// watcher) on temp data, isolated so its event loop is measured apart from the clients.
// Prints one JSON line with the connection info; on "stop" in stdin prints its stats and exits.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { backend, captureLogs } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";

const logs = captureLogs();
const users = Number(process.argv[2] ?? 5);
const server = await startBackend({ websockets: true, gene: true });
const { vaultEvents } = await backend("syncEvents.ts");

const published: { type: string; origin?: string }[] = [];
vaultEvents.on("change", (change: { type: string; originClientId?: string }) =>
  published.push({ type: change.type, origin: change.originClientId }),
);

const tokens: string[] = [];
for (let i = 0; i < users; i++) tokens.push((await server.createUser(i)).token);

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
logs.out(JSON.stringify({ baseUrl: server.baseUrl, root: server.data.root, vault: server.data.paths.vault, gene: server.data.paths.vaultGene, tokens }));

process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("stop")) return;
  loop.disable();
  logs.out(
    JSON.stringify({
      published,
      loopMaxMs: loop.max / 1e6,
      loopP99Ms: loop.percentile(99) / 1e6,
      backendErrors: logs.backendErrors,
      unhandled: logs.unhandled,
    }),
  );
  process.exit(0);
});
