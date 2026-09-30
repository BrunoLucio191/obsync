# Known issues and open questions

Things found while documenting the code that are broken, inconsistent with
their own comments, or not fully explained. Each entry says whether it was
**verified** (reproduced by running the code) or only **found by reading**.
Remove an entry when it is fixed.

## Setup

### Backend: `npm start` and `npm run dev` point to a missing file

*Verified.* `backend/package.json` runs `node server.ts` and
`node --watch server.ts`, but the entry file is `backend/main.ts`; there is no
`server.ts`. Until the scripts are fixed, start the backend from `backend/`
with:

```bash
node --watch main.ts
```

The `test` script also references files that do not exist (`Classes/*.test.ts`,
`serverConfig.test.ts`, `auth/*.test.ts`), and `dev2` uses `tsx`, which is not
installed.

### Backend: startup crashes when `data/vault/` is missing

*Verified.* On a fresh clone `backend/data/vault/` does not exist (it is
git-ignored). `Gene.mutateVaultGene()` calls `fs.watch()` on it and the process
exits with `ENOENT: no such file or directory, watch '.../data/vault'`, right
after printing `Server running on ...`. Create the folder before the first
start: `mkdir -p backend/data/vault`. The `Gene` constructor detects the
missing folder but only logs a message and continues.

### Plugin: the first `npm run build` fails on a fresh clone

*Verified.* The build runs `tsc` before esbuild, but
`src/Workers/zipWorker/zip.worker.generated.ts` is produced by esbuild and is
git-ignored, so `tsc` fails with
`Cannot find module './zip.worker.generated.ts'`. Run
`node esbuild.config.mjs production` once from `plugin/obSync/` (or start
`npm run dev`), then build normally.

### Runtime ZIP files are committed

*Found by reading.* `backend/data/zips/` contains two `.zip` files tracked by
git. They are temporary initial-download archives and look like they were
committed by accident. The folder itself must exist for `initSync` to work,
which may be why it was kept.

## Backend

### Awareness ownership never transfers

*Found by reading.* `AwarenessOwnershipGuard` has a branch that lets the same
user take over a Yjs client id from an older socket (a reconnect). It compares
identities through `getYjsDebugConnection()`, but `registerYjsDebugConnection()`
is never called anywhere, so the lookup always returns an empty context and the
comparison always fails. In practice every client id already owned by another
socket is ignored as a `cross-user-client-id-collision`, including the same
user's own reconnect. The debug context is also why the logged
`currentOwner`/`attemptedOwner` details show `connectionId: "unknown"`.

### `PUT /api/sync/modify` does not update Yjs state

*Found by reading, not reproduced.* `modify` rewrites
`data/vault/<path>` but does not touch `yjs-state/<path>.yjs-state`. For a
Markdown note that already has Yjs state, the next time a room opens,
`bindState()` loads the older binary state and the first flush writes it back
over the `.md`, undoing the modification. The plugin avoids sending `modify`
for the note open in the editor, but an admin can still change a closed note
through another app or a plugin, which produces a `modify`.

### Yjs persistence is outside the `KeyedLock`

*Found by reading, not reproduced.* `YjsPersistence` serializes its own writes
per document but does not take the shared `KeyedLock` used by the HTTP file
routes. `#flushLoop()` checks `isPathDeleted()` and then awaits two writes. If
a delete lands between the check and `#writeMarkdown()`, the write could
recreate the file (`#atomicWrite` creates parent folders). The delete route
marks the path deleted first, which narrows the window without closing it.

### Different operations on the same path can overlap across clients

*Unclear whether intended.* Lock keys include the operation name
(`file:<path>:modify`, `file:<path>:delete`), so a `modify` from one client and
a `delete` from another on the same path do not exclude each other. Each
client's own requests are still ordered by its queue.

### The room queue limit is per room, not per connection

*Found by reading.* `MAX_PENDING_MESSAGES_PER_DOCUMENT` (1,024) counts messages
from every connection of a room. The socket that sends message number 1,025 is
closed, which is not necessarily the one that flooded the queue.

### Misleading log when a room fails to load

*Found by reading.* If `bindState()` fails, `room.ready` rejects. The registry
closes the connections correctly with `1011`, but every message still waiting
in the room queue is also logged as `[Yjs] Invalid message in <path>`, which
points at the payload instead of the storage failure.

### Leftover debug output and inconsistent logs

*Found by reading.* `FileManager.rename()` prints the resolved paths with bare
`console.log` calls. Several messages in `Gene.ts` have no bracketed prefix and
mix Portuguese and English.

### Refresh token reuse is not treated as theft

*Improvement, not a bug.* Presenting an already rotated refresh token simply
fails. Many implementations revoke the whole session in that case, since it
means two parties hold the token.

## Plugin

### The backend URL is editable by every role

*Found by reading.* `BackendConnectionSection`'s comment says only admins can
edit the URL after the first login, but the code does not check the role: every
signed-in account can change it. Earlier documentation described both
behaviors at different times; the code is the reference until the intended
rule is decided.

### Backend error codes are not localized

*Found by reading.* `i18n/backendErrors.ts` maps lowercase reason codes
(`not_found`, `last_admin`, ...), but `UserMutationResult` now uses uppercase
codes (`NOT_FOUND`, `LAST_ADMIN`, `INVALID_ROLE`, `NAME_EXISTS`,
`INVALID_CURRENT_PASSWORD`). Those errors fall back to the backend's English
message. `email_exists` and `name_exists` from user creation are still lowercase
and are translated.

### `collab.ts` keeps state at module level

*Design inconsistency.* The rest of the plugin uses classes with `#` fields.
`collab.ts` keeps a module-level `activeRoom` and passes an `ActiveRoom` object
with about twenty public fields to most of its functions. It also duplicates
the "one room at a time" rule that `CollaborationController` already enforces.

### Unused constant

`INITIAL_NETWORK_SYNC_TIMEOUT_MS` in `collab/collab.cons.ts` is not used.
