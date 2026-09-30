# Collaboration

Collaboration is the live, character-level editing of the Markdown note open in
the editor. Each open note is a **room**: on the backend, one shared `Y.Doc`
per note path, and on each client, the documents bound to the editor. This
page follows an edit from the keyboard to disk and explains the pieces that
make it safe: role-dependent documents on the client, the per-room message
queue and write check on the server, awareness ownership, and persistence.

## Yjs vocabulary used here

- **`Y.Doc`**: the container of one note's collaborative state. The note's text
  lives in a `Y.Text` named `codemirror`, which the editor binding
  (`y-codemirror.next`) keeps in step with CodeMirror.
- **Update**: a binary diff produced by a `Y.Doc` when it changes. Applying the
  same updates in any order gives the same result.
- **State vector**: a compact summary of which updates a document already has,
  so two sides can exchange only what the other is missing.
- **Awareness**: short-lived presence data (name, cursor color, cursor
  position). It is broadcast but never stored.
- **Provider**: `WebsocketProvider` from `y-websocket`, which carries updates
  and awareness over a WebSocket.

## Client: one room at a time

`CollaborationController` watches Obsidian's `active-leaf-change` and
`file-open` events. When the active file is a Markdown note, it calls
`join(path)`; otherwise it disconnects. Only one room is open at a time.

`join()` is asynchronous and the user may switch notes before it finishes. A
generation counter (`#roomGeneration`) is incremented on every join and
disconnect, and each step checks that its generation is still current before
touching the editor.

The room is built by `setupCollabRoom()` in `collab/collab.ts`, in this order:

1. Create the documents (see the next section).
2. Open the IndexedDB cache for the note and wait until it is loaded.
3. Put the cached text into the editor (`#restoreEditorText`).
4. Install the CodeMirror Yjs extension.
5. Only now call `connect()`: request a ticket and open the WebSocket.

Loading the local cache before connecting means the editor never shows an
empty note while the network catches up, and offline edits are already in the
document when the sync with the server starts.

### Role-dependent documents

```ts
const ydoc = new Y.Doc();                                   // bound to the editor and IndexedDB
const networkDoc = user.role === 'user' ? new Y.Doc() : ydoc;
const provider = new WebsocketProvider(wsUrl, roomName, networkDoc, { connect: false, ... });
```

**Admin**: one document. Editor, IndexedDB and provider share `ydoc`, so every
edit is sent to the server.

```text
Editor <-> ydoc <-> IndexedDB (namespace obsync:v3:global)
            ^
            └──> WebsocketProvider <-> server
```

**Regular user**: two documents. The provider only ever sees `networkDoc`.
Updates arriving from the server are copied into the private `ydoc`; nothing
copies in the other direction.

```ts
networkDoc.on('update', (update) => Y.applyUpdate(ydoc, update, provider));
```

```text
server -> WebsocketProvider -> networkDoc -> ydoc -> Editor
                                              └──> IndexedDB (namespace obsync:v3:private:<email>)
```

The user's edits therefore have no path to the network, even if the server
check described below were missing. The IndexedDB namespaces are separate so
that an admin signing in on the same Obsidian profile never restores, and then
publishes, a regular user's private history.

### Tickets and reconnection

Each WebSocket needs a fresh one-use ticket (see [Security](security.md)).
`reconnectWithFreshTicket()` requests a ticket, puts it in
`provider.protocols`, and calls `provider.connect()`.

`y-websocket` normally reconnects by itself after a drop, but it would reuse
the same protocols, which contain an already-consumed ticket, and fail with
`401` forever. The room's `connection-close` handler sets
`provider.shouldConnect = false` to switch that off and schedules its own
reconnect with a new ticket and exponential backoff (up to 30 s). Coming back
online or making the window visible again triggers an immediate attempt.

### Presence

Each client publishes `{ id: <email>, name, color, colorLight }` as its
awareness state. The cursor color comes from the user's profile and can be
changed in **Settings → ObSync → Account**. "User joined" and "user left"
notices are grouped per user, and a leave waits 1 s so that a quick reconnect
does not produce a leave followed by a join.

## Server: rooms and connections

```text
YjsRoomRegistry: Map<docName, YjsRoom>
  "Projects%2Fplan.md" ─▶ YjsRoom
                           doc            one Y.Doc, shared by every connection
                           awareness
                           messageQueue   one queue for all connections of the room
                           connections    Map<WebSocket, YjsConnectionState>
                             admin socket ─▶ { userId, canWriteGlobal: true,  ... }
                             user socket  ─▶ { userId, canWriteGlobal: false, ... }
```

A room belongs to a **note**, not to a user: everyone with the same note open
shares one `YjsRoom` and one `Y.Doc`. Per-user information lives in the
`YjsConnectionState` of each socket.

### Connection setup (`YjsCollaborationServer.setupConnection`)

1. Parse the note path from the URL (`parseDocumentIdentity`): decode it,
   normalize slashes, reject empty paths and `.`/`..` segments.
2. Refuse the connection if the path is marked deleted.
3. `YjsRoomRegistry.reserve()` returns the existing room or creates one. A
   room that is in the middle of shutting down is not reused; the client gets
   `1013` and reconnects a moment later.
4. Build the connection state. `canWriteGlobal` is computed here, once, from the
   role that was reloaded from SQLite during the ticket check:
   ```ts
   canWriteGlobal: authenticatedUser.userRole === "admin",
   ```
5. Wait for `room.ready`, then send the server's state vector
   (`SyncStep1`) and the current awareness states.

If the user's role changes later, the WebSocket server closes the socket with
`4003`; the reconnect goes through a new ticket and gets the new role.

### Room creation and `room.ready`

`YjsRoomRegistry.#create()` builds the room and starts loading it:

```ts
room.ready = (async () => {
  await this.#persistence.bindState(docName, room.doc);  // load from disk
  room.attachListeners(...);                             // start broadcasting
})()
```

Listeners are attached after loading on purpose: the content loaded from disk
must not be broadcast as if it were a new edit. If loading fails, every
connection of the room is closed with `1011` and the room is discarded.

### The per-room message queue

Clients start sending messages as soon as the socket opens, possibly before the
room has loaded. `YjsConnectionSession.#enqueueMessage()` puts every incoming
message on the room's `messageQueue`, a promise chain:

```ts
const task = room.messageQueue.then(async () => {
  await room.ready;                               // wait for the document to load
  if (this.#connectionState.closed) return;       // socket gone while waiting
  this.#processMessage(message);
});
room.messageQueue = task
  .catch(() => closeConnection(this.#connection, 1007, "Invalid Yjs payload"))
  .finally(() => { room.pendingMessages -= 1; });
```

This guarantees that messages are processed after the room is loaded and in
arrival order across all connections of the room. The `.catch` keeps one
invalid message from breaking the chain for everyone else; only the offending
socket is closed. At most 1,024 messages may be pending per room, after which
the sender is closed with `1013`. See [Concurrency](concurrency.md#the-room-message-queue)
for how the promise chain works.

### Message types

`#processMessage()` rejects empty and oversized (over 16 MiB) messages and
messages for a deleted path, then dispatches on the first varint:

| Type | Handling |
| --- | --- |
| `0` sync | `syncMessageHandler` |
| `1` awareness | `AwarenessOwnershipGuard.applyUpdate` |
| `3` query awareness | Replies with the room's awareness snapshot |
| `2` auth | Rejected: authentication happens at the handshake, never inside the protocol |
| anything else | Rejected |

### The write check (`SyncMessageHandler.ts`)

```text
SyncStep1 (client sends its state vector)  → answered for every role with SyncStep2
SyncStep2 / Update (client sends changes)  → canWriteGlobal? apply : drop and audit
```

Answering `SyncStep1` is what lets a regular user receive the note. Dropped
writes never reach `room.doc`, so they are neither broadcast nor stored. Each
one is logged as `[Audit] Global Yjs update blocked` with the user id, role and
path.

### Awareness ownership (`AwarenessOwnershipGuard.ts`)

Without a check, any connection could send an awareness entry with another
user's client id and move or erase their cursor. The guard only accepts an
entry when:

- the entry's `user.id` equals the e-mail authenticated at the handshake, and
- no other connection already owns that client id, or the owner is the same
  user.

Removals (`state: null`) are accepted only from the connection that owns the
client id. When a socket closes, the awareness entries it owned are removed.

The "same user reconnecting takes over ownership" branch depends on a debug
registry that is never populated, so in practice a client id already owned by
another socket is always refused. See
[Known issues](known-issues.md#awareness-ownership-never-transfers).

### Room shutdown

When the last connection and reservation are gone,
`YjsRoomRegistry.#scheduleCleanup()`:

1. waits for `room.messageQueue`, so pending messages are applied;
2. waits for `room.ready` and writes the final state;
3. removes the room and destroys the document.

After each `await` it checks again whether a connection arrived in the
meantime, and cancels the shutdown if so.

## Persistence (`backend/Server/YjsPersistence.ts`)

The room's `Y.Doc` lives in memory. `YjsPersistence` writes every note twice:

| File | Location | Role |
| --- | --- | --- |
| `<path>.yjs-state` | `backend/data/yjs-state/` | The authority: the complete binary Yjs state |
| `<path>` (the `.md`) | `backend/data/vault/` | A readable mirror, also what `getFile` and the initial ZIP serve |

**Why the binary state is needed and the Markdown is not enough.** Yjs
identifies every inserted character by the client that inserted it and a
counter. Clients keep documents longer than a room lives: the editor's `ydoc`
survives a network drop, and IndexedDB survives restarts. If the server
rebuilt a room from the `.md` file, it would insert the whole text as a new
operation with new identities. A client reconnecting with its old document
would see two unrelated insertions and keep both: **the text would appear
twice**. Loading `.yjs-state` restores the original identities, so the sync
exchanges only real differences.

The `.md` file is only used to seed a note that has never had Yjs state
(`#bootstrapFromMarkdown`).

The binary state is not an edit history: the server `Y.Doc` uses the default
garbage collection, so the content of deleted text is discarded and only
placeholders remain. It stores no timestamps or user ids either.

### Write path

- Every `update` on the document marks it dirty and calls `#flush()`.
- `#flush()` never runs two writes for the same document at once; concurrent
  calls share the running write.
- `#flushLoop()` repeats while the document is dirty, so updates that arrive
  during a slow write are saved by one more pass instead of one write each.
- Before writing, it checks that the document was not invalidated and the path
  not deleted, so a late write cannot resurrect a deleted note.
- Each file is written to a temporary file and renamed over the target
  (`#atomicWrite`), so a crash never leaves a half-written file. The binary
  state is written before the Markdown.

`YjsPersistence` is created inside `WebSocketServer.initializeWebSockets()` and
attached through `YjsCollaborationServer.setPersistence()`. Until then,
`YjsPersistenceGateway` silently ignores every call.

## Related pages

- [File synchronization](file-sync.md)
- [Authorization model](permissions.md)
- [Plugin collaboration reference](reference/plugin/collaboration.md)
- [WebSocket API](reference/backend/websocket.md)
