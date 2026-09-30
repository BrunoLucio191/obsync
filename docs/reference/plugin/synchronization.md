# Plugin synchronization API

File synchronization moves vault structure and whole files; it is separate from
character-level Yjs collaboration. The concepts and flows are explained in
[File synchronization](../../file-sync.md).

## Initial download

### SyncInitialVault

Source: [`src/sync/SyncInitialVault.ts`](../../../plugin/obSync/src/sync/SyncInitialVault.ts)

```ts
new SyncInitialVault(app, auth, mutedPaths, queueManager, merger)
sync(): Promise<void>
```

Each `sync()` builds a new `Boss` around a new `ZipWorkerSon` and runs it.
Called when synchronization starts and, debounced, when a regular user needs a
full resync after a folder rename.

### Boss

Source: [`src/Workers/Boss.ts`](../../../plugin/obSync/src/Workers/Boss.ts)

```ts
new Boss(zipWorkerSon: ZipWorkerSon)
startWorking(): Promise<void>
```

A thin wrapper that starts its worker. It exists as an extension point for
more worker types; today it only delegates.

### ZipWorkerSon

Source: [`src/Workers/zipWorker/ZipWorkerSon.ts`](../../../plugin/obSync/src/Workers/zipWorker/ZipWorkerSon.ts)

```ts
new ZipWorkerSon(app, mutedPaths, auth, queueManager, merger)
startWorking(): Promise<void>
```

1. Refreshes the access token if needed.
2. Sends `POST /api/sync/initSync` with `X-ObSync-Gene` when a gene was saved.
3. On `204`, shows "vault up to date" and stops.
4. On `200`, keeps the `X-ObSync-Gene` response header, starts a Web Worker
   from the bundled source string, and transfers the ZIP bytes to it.
5. When the Worker answers, writes every entry inside one queue task
   (`vault:initialSync`): admins write files directly, regular users go through
   `ServerVersionMerger.apply()`. Every path is muted first.
6. Saves the new gene in `SecretStorage` (`obsync-vault-gene-<vault name>`),
   only after all entries were written.

### zip.worker

Source: [`src/Workers/zipWorker/zip.worker.ts`](../../../plugin/obSync/src/Workers/zipWorker/zip.worker.ts)

Runs inside the Web Worker. Receives an `ArrayBuffer`, unzips it with JSZip, and
posts back a `ZipWorkerMessage`:

```ts
type ZipWorkerEntry =
  | { path: string; isDir: true }
  | { path: string; isDir: false; content: ArrayBuffer; ext: string };

type ZipWorkerMessage =
  | { status: "success"; entries: ZipWorkerEntry[] }
  | { status: "error"; message: string };
```

File contents are transferred, not copied. `esbuild.config.mjs` bundles this
file into `zip.worker.generated.ts` as a string before building the plugin.

## SyncVaultChanges

Source: [`src/sync/SyncVaultChanges.ts`](../../../plugin/obSync/src/sync/SyncVaultChanges.ts)

```ts
new SyncVaultChanges(plugin, auth, mutedPaths, collaboration, queueManager)
initialize(): void
```

Registers Obsidian's `create`, `delete`, `modify` and `rename` vault events.
Each handler:

1. reads the path(s) immediately, because Obsidian renames file objects in
   place;
2. returns if the account is not an admin or a path is muted;
3. queues one task on the client's queue with key `local:<path>:<type>`;
4. inside the task, skips files deleted before they were published, refreshes
   the token, re-checks the admin role, and sends the request.

| Event | Request |
| --- | --- |
| `create` | `POST /api/sync/create`; non-empty binaries go to `POST /api/sync/createFile` |
| `modify` | `PUT /api/sync/modify` or `createFile` for binaries; ignored for the active file |
| `delete` | `DELETE /api/sync/delete`; disconnects the collaboration room if affected |
| `rename` | `PUT /api/sync/rename`; `404` ignored; rejoins the room if the active note moved |

Binary files are detected by extension (`vault/binaryExtensions.ts`).

## SystemChannel

Source: [`src/sync/SystemChannel.ts`](../../../plugin/obSync/src/sync/SystemChannel.ts)

```ts
new SystemChannel(auth, remoteChanges)
connect(): void
disconnect(): void
```

`connect()` closes any current socket, requests a `system` ticket and opens
`<ws base>/system`. Each message is parsed as a `VaultChange`; events whose
`originClientId` is this client's id are ignored, the rest go to
`RemoteVaultChangeService.apply()`.

A generation counter invalidates callbacks from superseded attempts. After an
unexpected close the channel reconnects with exponential backoff (0.5 s to
30 s, with jitter) and a new ticket; close code `4003` refreshes the session
first.

## RemoteVaultChangeService

Source: [`src/vault/RemoteVaultChangeService.ts`](../../../plugin/obSync/src/vault/RemoteVaultChangeService.ts)

```ts
new RemoteVaultChangeService(app, auth, mutedPaths, collaboration, queueManager, merger, requestFullSync)
apply(change: VaultChange): Promise<void>
```

Queues the change (`remote:<path>:<type>`) and applies it:

| Type | Behavior |
| --- | --- |
| `create` | Folder: `mkdir`. Binary: download with `GET /api/sync/getFile`. Text: write `content` |
| `modify` | Write `content` |
| `delete` | Forget the merge base, disconnect the room if affected, move the file to Obsidian's trash (or remove it if Obsidian does not track it) |
| `rename` | Move the local file; for a regular user whose file is already gone, `#followServerRename()` finds an unedited moved copy, downloads the file, or requests a full sync for folders |

Text writes for regular users go through `ServerVersionMerger.apply()`.
Binaries that returned `404` are remembered and fetched again if a later rename
covers their path. Every written path is muted first.

## ServerVersionMerger

Source: [`src/vault/ServerVersionMerger.ts`](../../../plugin/obSync/src/vault/ServerVersionMerger.ts)

```ts
new ServerVersionMerger(app, mutedPaths, store: SyncBaseStore)
apply(path: string, data: ArrayBuffer | string): Promise<void>
findMovedCopy(oldPath: string): Promise<string | null>
rename(oldPath: string, newPath: string): Promise<void>
forget(path: string): Promise<void>
```

`apply()` writes a server version into a regular user's vault without losing
local edits:

- text: write when the local file is missing, equal to the server version, or
  unchanged since the base; keep it when there is no base; otherwise
  `node-diff3` merge with labelled conflict markers and a notice;
- binary: write under the same conditions; otherwise save the server version as
  `name (server version).ext`.

The server version then becomes the new base.

`findMovedCopy()` looks for a file with the same name and the same hash as the
base of `oldPath` that has no base of its own: a copy the user moved without
editing.

### SyncBaseStore

Source: [`src/vault/SyncBaseStore.ts`](../../../plugin/obSync/src/vault/SyncBaseStore.ts)

```ts
new SyncBaseStore(adapter: DataAdapter, dir: string)   // dir = <plugin folder>/sync-base
static hash(data: ArrayBuffer | string): Promise<string>   // SHA-256, hex
getHash(path) / getText(path) / setText(path, text) / setBinary(path, hash)
rename(oldPath, newPath) / forget(path)
```

Keeps `index.json` (`path → { hash, text }`) and one `<hash>.txt` per distinct
text version. Text files are shared by hash and deleted when no path refers to
them. `rename` and `forget` also apply to everything under a folder path.

## PathMuteRegistry

Source: [`src/vault/PathMuteRegistry.ts`](../../../plugin/obSync/src/vault/PathMuteRegistry.ts)

```ts
new PathMuteRegistry(muteDurationMs = 2_000)
```

| Method | Description |
| --- | --- |
| `mute(path)` | Mutes the path until now + duration |
| `isMuted(path)` | True if the path or one of its ancestors is muted |
| `clear()` | Removes all entries |
| `PathMuteRegistry.contains(root, candidate)` | True if `candidate` equals `root` or is inside it |

```ts
mutedPaths.mute("Projects");
mutedPaths.isMuted("Projects/note.md"); // true
```

## Related references

- [VaultChange](types.md#vaultchange)
- [HTTP sync endpoints](../backend/http.md#vault-synchronization)
- [Storage](../../storage.md#plugin)
