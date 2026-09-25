---
name: obsync-test
description: Ready-made test harness for obSync (Express backend + Obsidian plugin) that runs the real backend and the real plugin code without opening Obsidian. Use it whenever you need to test, verify, reproduce or stress-test obSync behavior, such as the sync routes, moving or renaming files and folders, initial sync and the vault gene, the cursor color and account settings, the queues, or several users editing the vault at once over WebSocket. Also use it after changing backend or plugin sync code, to confirm nothing broke. Prefer it over writing a new ad-hoc harness, and extend it with a new scenario when something is not covered.
---

# obSync test harness

Everything runs against the real code: the backend stack is the one `backend/main.ts` builds
(ExpressServer with real auth, WebSocketServer, Yjs persistence, Gene watcher) on temp data,
and plugin classes are bundled from `plugin/obSync/src` with the plugin's own esbuild. Only
Obsidian itself is faked. Output is compact on purpose: one summary line per scenario, and
details only for what failed, so relay those lines to the user instead of re-deriving them.

## Run

```bash
node .claude/skills/obsync-test/scripts/run.ts all                 # every scenario
node .claude/skills/obsync-test/scripts/run.ts move gene           # some of them
node .claude/skills/obsync-test/scripts/run.ts multiuser --users 10 --seed 3 --ops 60
```

`run.ts` runs each scenario in its own process group with a time limit (`--timeout`, default
120s; macOS has no `timeout` command), removes leftover `obsync-test-*` temp dirs, and fails
if anything under `backend/data` changed. Other flags are passed to the scenarios.

| Scenario | What it checks |
|---|---|
| `queue` | Queue/QueueManager/KeyedLock, backend and plugin copies: order, error isolation, same key never concurrent, queue removed when drained |
| `move` | Moving notes, folders with subfolders, several folders, create+move+rename; server vault must equal the client's with no failed request (`--runs`) |
| `getfile` | getFile serves only files inside the vault (404 otherwise, including `../` paths), createFile events carry `originClientId`, a client recovers binaries renamed before it could download them |
| `gene` | initSync with the vault gene: 204 when unchanged, gene saved in secretStorage only after a complete sync, per-vault secret id |
| `color` | Cursor color in SQLite, `PATCH /api/auth/color`, plugin AuthService and the Account settings item |
| `multiuser` | N admin clients editing their own `user-N/` folder at once, randomly connected, unstable or offline on `/system`; server in a child process with event loop metrics |

In `multiuser`, "instavel" clients drop the socket for a while; what they miss is printed as
`info`, not a failure, because the plugin does not resync on reconnect by design. A failing
seed can be replayed exactly with the same `--users/--seed/--ops`.

## Adding a scenario

Create `scripts/scenarios/<name>.ts`, add the name to `SCENARIOS` in `run.ts`, and build it
from `scripts/lib`:

```ts
import { captureLogs, fakeObsidian } from "../lib/env.ts"; // must be the first import
import { startBackend } from "../lib/backend.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { diskTree, waitForQuiet } from "../lib/fake-vault.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
const { netStats } = await fakeObsidian();
const server = await startBackend();                 // { websockets, gene } flags
await loadPlugin(server.baseUrl);
const { token } = await server.createUser(0);        // real access token
const client = await createClient({ clientId: "c1", token, websocket: false });
client.vault.createFile("a.md", "hi");               // fires vault events like Obsidian
await waitForQuiet(netStats);
const checks = createChecks("my-scenario", logs.out);
await checks.check("server has the file", async () => { /* throw on failure */ });
const code = checks.finish();
await server.data.cleanup();
process.exit(code);
```

For plugin classes not covered by `createClient`, use `bundlePlugin({ Name: "path/in/src.ts" })`.

## Things that cost time before

- Import plugin code through `bundlePlugin`, not directly: plugin files import types as values
  (`import { ZipWorkerMessage } ...`), which Node's type stripping keeps and then fails on.
  One bundle also means one shared module state (ApiConfig's base URL).
- `useTempData` redirects every `systemPaths` entry and refuses to run if one still points at
  `backend/data`. Never point a scenario at the real data.
- Do not start the Gene watcher in a process that deletes its temp dir itself: the watcher keeps
  rewriting `gene.json` and the cleanup hangs. That is why `multiuser` runs the server in
  `server-process.ts`. Running server and clients in one process also mixes their event loops,
  which once looked like a 26s server stall that was really the harness.
- The fake `requestUrl` must keep Obsidian's contract (`status`, `headers`, `arrayBuffer`,
  `text`, lazy `json`, throws on >= 400 unless `throw: false`), or AuthService-style code falls
  into its generic error path.
- Obsidian facts, read from the installed app code
  (`~/Library/Application Support/obsidian/obsidian-<version>.asar`, grep it with Python since
  ugrep chokes on long regexes): renaming a folder fires `rename` for the folder and then one per
  descendant; `adapter.rename` fires those events synchronously while other adapter writes arrive
  later through the file watcher; secretStorage is per vault on desktop (localStorage prefixed
  with the app id) but one shared key on mobile.
- zsh: quote globs (`--include='*.ts'`) and avoid `echo ====`.
