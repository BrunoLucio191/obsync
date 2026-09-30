# File synchronization

File sync keeps the **structure** of the vault and the **whole-file content**
of files that are not being edited live in agreement across clients. It is
separate from [collaboration](collaboration.md), which moves the characters of
the one note open in the editor. File sync has three parts: an initial
download when the plugin starts, publishing an admin's local changes, and
applying changes that other clients made.

## 1. Initial download and the vault gene

When sync starts, the plugin asks for the whole vault as a ZIP. Downloading the
entire vault on every Obsidian launch would be wasteful, so the backend keeps a
**vault gene**: a small JSON fingerprint stored in `backend/data/gene.json`.

```json
{ "generation": 197, "bytes": 9062416, "filesCount": 99, "lastModification": "2026-09-25T16:49:09.352Z" }
```

### How the gene is kept up to date (`backend/Server/Gene.ts`)

`Gene.mutateVaultGene()` starts a recursive `fs.watch` on `data/vault/`. Every
filesystem event queues an update that rescans the vault, increments
`generation`, and records the byte and file counts. The update runs on the
gene's own queue, with two consequences:

- A read (`readGene()`) never sees a half-written file, because reads and
  writes go through the same queue.
- Bursts collapse. If an update is already waiting in the queue, a new event is
  dropped: the waiting update rescans the vault when it runs, so it already
  covers the newer changes.

Because the watcher sees every write to `data/vault/`, the gene changes for
HTTP file operations and for Markdown files written by collaboration alike.

### The exchange

```text
ZipWorkerSon                                       SyncFilesController.initSync
────────────                                       ────────────────────────────
reads saved gene from SecretStorage
POST /api/sync/initSync
  X-ObSync-Gene: <saved gene> (if any)  ────────▶  currentGene = gene.readGene()
                                                   same as X-ObSync-Gene? ──▶ 204 No Content
                                                   otherwise:
                                                     zip data/vault/ into data/zips/<clientId>.zip
                                   ◀────────────     200, the ZIP, X-ObSync-Gene: <currentGene>
                                                     delete the ZIP 15 s later
unzip in a Web Worker
write every entry (queued on the client)
save the received gene in SecretStorage
```

Details worth knowing:

- The gene is compared as a string (the JSON text). Any change to the vault
  gives a different string.
- The plugin saves the new gene **only after every entry was written**, so an
  interrupted download is retried in full next time.
- The gene is read before zipping. If a change lands between the two, the
  client receives newer files with an older gene, which only costs one extra
  download on the next launch. The code accepts this on purpose rather than
  locking the vault during the ZIP.
- The saved-gene key includes the vault name
  (`obsync-vault-gene-<vault name>`), because Obsidian mobile shares
  `SecretStorage` across vaults.
- Hidden files and folders (names starting with `.`) are not included in the
  ZIP.

### Writing the entries

`ZipWorkerSon.#writeEntries()` treats the two roles differently:

- **Admins** write each file exactly as the server sent it. The server is the
  source of truth and an admin has nothing private to protect.
- **Regular users** hand each file to `ServerVersionMerger.apply()`, described
  in [section 4](#4-regular-users-merging-server-versions).

Every path is muted in `PathMuteRegistry` before it is written, explained next.

## 2. Publishing an admin's local changes

`SyncVaultChanges.initialize()` registers Obsidian's vault events. Each event
becomes one task on the client's queue, which sends one HTTP request:

| Obsidian event | Request | Notes |
| --- | --- | --- |
| `create` (folder or text file) | `POST /api/sync/create` `{ path, isFolder, content }` | |
| `create` (non-empty binary) | `POST /api/sync/createFile` with raw bytes and `X-ObSync-filePath` | Binaries are never read as text, which would corrupt them |
| `modify` | `PUT /api/sync/modify` `{ path, content }` or `/createFile` for binaries | Skipped for the active file: the collaboration room owns it |
| `delete` | `DELETE /api/sync/delete` `{ path, isFolder }` | Also closes the collaboration room if it is under `path` |
| `rename` | `PUT /api/sync/rename` `{ oldPath, newPath }` | A `404` means the server never had the source and is ignored |

### Feedback loops and `PathMuteRegistry`

When the plugin itself writes to the vault (applying a remote change, the
initial download), Obsidian fires the same `create`/`modify` events as a human
edit. Without protection, the plugin would publish the server's own change
back to the server. `PathMuteRegistry` breaks the loop:

```ts
this.#mutedPaths.mute(change.path);          // before writing
await adapter.write(change.path, content);
// ...later, in SyncVaultChanges:
if (this.#mutedPaths.isMuted(path)) return;  // event caused by our own write
```

A mute lasts 2 seconds and covers everything under a muted folder. The check
happens when the event fires, not later inside the queued task, for two
reasons: the queued order must match the event order, and a mute could expire
while the task waits.

### Why paths are read when the event fires

Obsidian renames a `TFile` object in place. If a task read `file.path` when it
ran instead of when the event fired, a `create` queued before a rename would
send the new name. Each handler captures the path immediately.

### Files deleted before they were published

If a file is created and deleted quickly, its `create` task may run after the
delete. The task notices that the file is gone (`#isGone()`), records it in
`#unpublished`, and the later `modify`, `rename` and `delete` tasks for that
file send nothing.

## 3. Applying changes from other clients

### Backend side

Every successful mutation in `SyncFilesController` calls
`publishVaultChange()`. `WebSocketServer` listens to that emitter and sends the
change as JSON to every open `/system` socket:

```json
{ "type": "rename", "oldPath": "Projects/a.md", "newPath": "Archive/a.md", "isFolder": false, "originClientId": "9b1e..." }
```

The mutations also keep the collaboration state consistent:

| Route | Extra work on the Yjs side |
| --- | --- |
| `create` | If the path was deleted earlier, remove its old `.yjs-state` so the new file does not inherit old history; clear the deleted mark |
| `delete` | Mark the path deleted (closes live rooms under it), delete the file, remove its `.yjs-state` |
| `rename` | Move the `.yjs-state` along with the file |
| `modify` | Refuse with `409` if the path is marked deleted |

`FileManager.rename()` returns `"already-applied"` when only the destination
exists. Obsidian reports a moved folder first and then each file inside it; by
the time the per-file renames arrive, the folder move already moved them, so
they succeed without broadcasting again.

### Plugin side

`SystemChannel` receives the event, drops it if `originClientId` equals its own
`clientId`, and passes it to `RemoteVaultChangeService.apply()`, which queues
it. For each type:

- **create**: folders are created; text content is written; binaries are
  downloaded with `GET /api/sync/getFile` (binary content is not sent over
  `/system`).
- **modify**: the new content is written.
- **delete**: the file goes to Obsidian's trash when Obsidian tracks it, so a
  deletion made by someone else can be recovered.
- **rename**: the local file is moved.

A binary that was already renamed or deleted on the server when the client
asked for it returns `404`. The service remembers it in `#missedBinaries`; if a
later rename event covers that path, the file is fetched from its new
location.

## 4. Regular users: merging server versions

A regular user can edit any file locally, and those edits never reach the
server. When the server version of that file changes, overwriting the local
file would destroy the user's work. `ServerVersionMerger` solves this with a
**three-way merge**, the same idea Git uses: compare both versions with their
last common ancestor (the *base*) to tell which side changed what.

`SyncBaseStore` keeps the base: the last server version this client received
for each path. It stores an index `path → hash` in
`<plugin folder>/sync-base/index.json`, plus the text of each version in
`<hash>.txt` (binaries store only the hash).

For a text file, `#applyText()` decides:

| Situation | Result |
| --- | --- |
| No local file, or local equals incoming | Write the server version |
| Local equals the base (the user did not edit it) | Write the server version |
| Local differs and no base is known | Keep the local file untouched |
| Local and server both changed | `node-diff3` merge; on conflict, write conflict markers labelled "your version" / "server version" and show a notice |

For binaries there is no merge. If the user changed the file, the server
version is saved next to it as `name (server version).ext`.

After applying, the incoming version becomes the new base.

### Renames for regular users

If an admin renames a file the user had already moved locally, the old path no
longer exists on the user's device. `#followServerRename()` looks for an
unedited copy (same file name and same hash as the base) and moves it to the
new path. If it finds none, it downloads the server version to the new path.
For a folder it schedules a full initial sync instead (debounced by one second
in `ObSync.#scheduleFullSync()`).

## Related pages

- [Collaboration](collaboration.md): the live-editing side
- [Concurrency and ordering](concurrency.md): the queues used above
- [HTTP API](reference/backend/http.md#vault-synchronization)
- [Plugin synchronization reference](reference/plugin/synchronization.md)
