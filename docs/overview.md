# System overview

ObSync lets several Obsidian clients work on one shared vault that lives on a
self-hosted Node.js backend. This page is the map: what the parts are, how they
talk to each other, and what happens during the three operations everything
else is built on. The other pages zoom into one area each.

## The two roles

Every account has exactly one role, stored in the backend's SQLite database:

- **`admin`** accounts write to the shared vault. Their edits are published to
  every other client.
- **`user`** accounts receive everything admins publish, but their own edits
  stay on their device. They can type in a shared note, and nobody else will
  ever see it.

The rule behind every design decision is that **the backend is the source of
truth**. The plugin reports what happened locally; the backend decides whether
it is allowed and what the canonical vault looks like. The plugin also avoids
sending forbidden writes, but that is a convenience. The backend enforces the
policy on its own, so a modified client cannot bypass it.

## The parts

```text
Obsidian (plugin)                                  Node.js backend
─────────────────                                  ───────────────
AuthService ─────── HTTPS /api/auth/* ───────────▶ AuthController ── TokenService
UserAdminService ── HTTPS /api/users/* ──────────▶ UsersController ── DBServices ── SQLite
SyncVaultChanges ── HTTPS /api/sync/* ───────────▶ SyncFilesController ── FileManager ── data/vault/
ZipWorkerSon ────── HTTPS /api/sync/initSync ────▶ SyncFilesController ── Gene ── data/gene.json
SystemChannel ◀──── WSS /system ─────────────────  WebSocketServer ◀── vaultEvents
collab.ts ◀───────▶ WSS /<note path> ────────────▶ YjsCollaborationServer ── YjsPersistence ── data/yjs-state/
```

There are two independent synchronization mechanisms, and keeping them apart
is the most important thing to understand about the codebase:

| Mechanism | What it moves | Transport | Granularity |
| --- | --- | --- | --- |
| **File sync** | Vault structure (create, delete, rename) and whole-file content of files that are not open in the editor, including binaries | HTTPS requests up, `/system` WebSocket events down | Whole file |
| **Collaboration** | The text of the Markdown note currently open in the editor | One WebSocket per open note, speaking the Yjs protocol | Individual characters |

File sync is plain request/response plus broadcast. Collaboration uses
[Yjs](https://yjs.dev), a CRDT library. A CRDT (conflict-free replicated data
type) is a data structure where every replica can apply edits in any order and
still converge to the same result, which is what lets two people type in the
same paragraph at once without a lock.

## Repository layout

```text
backend/                 Node.js server (runs TypeScript directly, no build step)
  main.ts                composition root: builds every service and starts the servers
  auth/                  tokens, sessions, WebSocket tickets, password hashing, rate limits
  users/                 SQLite user database and user mutations
  Server/                HTTP server, WebSocket server, vault files, vault gene, Yjs persistence
    ExpressServer/       Express app, routers (routes/) and handlers (controllers/)
  yjs/                   collaboration rooms, Yjs protocol handling, awareness checks
  queue/                 Queue, QueueManager, KeyedLock (operation ordering)
  scripts/               database setup and a random-vault generator for testing
  data/                  runtime data: users.sqlite, vault/, yjs-state/, gene.json, zips/
plugin/obSync/           Obsidian plugin, bundled with esbuild into main.js
  src/main.ts            composition root: the Obsidian Plugin subclass
  src/auth/              session handling and the user-admin HTTP client
  src/collab/            Yjs room for the active note, offline IndexedDB cache
  src/sync/              initial download, publishing local changes, /system channel
  src/vault/             applying remote changes, three-way merge for regular users
  src/queue/             the same Queue/KeyedLock design as the backend
  src/Workers/           Web Worker that unzips the initial vault download
  src/settings/          settings tab: backend URL, account, user management
  src/i18n/              English and Portuguese UI strings
docs/                    this documentation
```

## Flow 1: signing in and opening a connection

1. The user enters the backend URL in **Settings → ObSync**. `ApiConfig`
   validates it (HTTPS required except on loopback) and derives the `ws://` or
   `wss://` URL from it.
2. `LoginModal` sends `POST /api/auth/login`. The backend checks the password
   (scrypt hash in SQLite), creates an in-memory session and returns a 15-minute
   access token plus a refresh token. The plugin stores both in Obsidian's
   `SecretStorage`, never in `data.json`.
3. To open a WebSocket, the plugin cannot send an `Authorization` header (the
   browser WebSocket API does not allow custom headers). It first calls
   `POST /api/auth/ws-ticket` with its access token and receives a random
   ticket valid for 30 seconds and one use.
4. It opens the socket with the ticket in the `Sec-WebSocket-Protocol` header.
   The backend consumes the ticket during the HTTP upgrade, reloads the user
   from SQLite, and only then accepts the connection.

Details: [Security](security.md).

## Flow 2: an admin types in a note

```text
admin editor ─▶ ydoc ─▶ WebsocketProvider ─▶ /<note>  ─▶ YjsConnectionSession (room queue)
                                                          ─▶ syncMessageHandler: canWriteGlobal? yes
                                                          ─▶ Y.applyUpdate(room.doc)
                                                               ├─▶ broadcast to every socket in the room
                                                               └─▶ YjsPersistence: write .yjs-state and .md
```

1. Opening a Markdown note makes `CollaborationController` join the room named
   after the note's path.
2. Each keystroke produces a small Yjs update that the provider sends over the
   socket.
3. On the backend, all messages for a room go through one ordered queue, then
   `syncMessageHandler` checks `canWriteGlobal` (true only for admins) and
   applies the update to the room's shared `Y.Doc`.
4. The room broadcasts the update to everyone connected to that note, and
   `YjsPersistence` writes the new state to disk.

A `user` account runs the same flow, but step 3 drops the update and logs
`[Audit] Global Yjs update blocked`. The plugin also never hands the user's
edits to the provider in the first place. Details:
[Collaboration](collaboration.md).

## Flow 3: an admin creates, renames or deletes a file

```text
Obsidian vault event ─▶ SyncVaultChanges (client queue) ─▶ PUT /api/sync/rename
   ─▶ requireAuth ─▶ requireAdmin ─▶ requireClientId ─▶ SyncFilesController.rename (server queue)
        ├─▶ move .yjs-state, move the file in data/vault/
        └─▶ publishVaultChange ─▶ WebSocketServer ─▶ every /system socket
                                                      ─▶ SystemChannel ─▶ RemoteVaultChangeService
```

The originating client ignores its own broadcast by comparing
`originClientId` with its own `X-ObSync-Client` id. Other admins apply the
change as is. Regular users apply it through `ServerVersionMerger`, which
merges the server version into their possibly edited local copy instead of
overwriting it. Details: [File synchronization](file-sync.md).

## Where to go next

- [Architecture](architecture.md): every module and why it is split that way
- [File synchronization](file-sync.md) and [Collaboration](collaboration.md): the two sync mechanisms in depth
- [Concurrency and ordering](concurrency.md): the queues that make operation order predictable
- [Common changes](common-changes.md): where to edit for typical tasks
- [Known issues](known-issues.md): behavior that looks wrong or is not fully explained yet
