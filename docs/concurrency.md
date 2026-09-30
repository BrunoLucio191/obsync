# Concurrency and ordering

Many operations in ObSync are asynchronous: HTTP requests, file writes, vault
events, WebSocket messages. Without coordination, two of them touching the same
file can interleave and leave the vault in a state nobody asked for. ObSync
serializes operations deliberately so that their order is **predictable across
the whole system**, not just to patch individual race conditions. This page
explains the three mechanisms that do it.

## The building blocks

### Promise chains

All three mechanisms rely on one JavaScript property: `promise.then(fn)`
registers `fn` inside `promise` and returns a new promise that resolves only
after `fn` (and any promise `fn` returns) has finished. Keeping only the **last**
promise in a variable and attaching each new task to it produces a queue:

```ts
let tail = Promise.resolve();

tail = tail.then(() => taskA());   // A waits for nothing
tail = tail.then(() => taskB());   // B waits for A
tail = tail.then(() => taskC());   // C waits for B
```

Overwriting `tail` does not lose `taskA`: the link "when A finishes, run B" is
stored inside A's promise, not in the variable. The variable only marks where
the next task should attach.

Two details decide whether such a chain works:

- **The callback must return the work.** An `async` callback returns a promise
  that resolves after its last `await`, so the chain waits for the whole task.
  A callback that starts work without returning it lets the next task start
  early.
- **A rejection must not become the tail.** `.then()` on a rejected promise
  skips its callback, so every later task would be skipped. Each mechanism
  below attaches a `.catch` (or `try/finally`) before storing the tail.

Node runs JavaScript on one thread, so reading the tail and replacing it is
never interrupted by another handler: the two lines run together, with no
`await` between them.

### `KeyedLock` (`queue/KeyedLock.ts`)

A lock per key: two operations with the same key never run at the same time,
even when they come from different queues. It is a promise chain per key:

```ts
readonly #lastInLine = new Map<string, Promise<void>>();

async #enterLine(key) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const predecessor = this.#lastInLine.get(key);   // current tail for this key
  this.#lastInLine.set(key, promise);              // become the tail
  if (predecessor) await predecessor;              // wait for the previous holder
  return () => {                                   // release
    if (this.#lastInLine.get(key) === promise) this.#lastInLine.delete(key);
    resolve();
  };
}
```

The key is removed from the map when its last holder releases, so the map does
not grow with every path ever touched.

Keys name an operation on a resource, for example `file:Projects/a.md:delete`,
`user:42:changeRole`, or `vault:gene:update`. One `KeyedLock` instance is
created in `main.ts` and shared by every queue on the backend; the plugin has
its own instance.

### `Queue` and `QueueManager` (`queue/Queue.ts`, `queue/QueueManager.ts`)

A `Queue` runs its tasks one at a time in arrival order, and each task first
takes the shared `KeyedLock` for its key:

```ts
const queue = this.#queueManager.getOrCreateQueue(clientId);
await queue.addTask(async () => {
  // the operation
}, `file:${path}:delete`);
```

`addTask()` returns a promise that settles with the task's own result or
error, which is what lets a controller write the HTTP response from inside the
task and still catch failures outside it.

`QueueManager` keeps one `Queue` per id and removes a queue once it drains.
Because a drained queue disappears, callers must add the task right after
`getOrCreateQueue()` and never keep the queue object across an `await`.

Together they give two guarantees:

| Guarantee | Provided by |
| --- | --- |
| Requests from the same client run in the order they were sent | One `Queue` per client id |
| Two operations on the same resource never overlap, whoever sent them | The shared `KeyedLock` |

## Where the queues are used

### Backend HTTP controllers

Every mutating route runs inside `queue.addTask()`, on the queue of the
caller's `X-ObSync-Client` id:

| Controller | Keys |
| --- | --- |
| `SyncFilesController` | `file:<path>:create`, `file:<path>:delete`, `file:<path>:modify`, `file:<newPath>:rename`, `file:<path>:writeBinary`, `file:<clientId>:send`, `vault:InitSync` |
| `UsersController` | `user:<id>:renameUser`, `user:<id>:changePassword`, `user:<id>:changeRole`, `user:<id>:changeStatus`, `user:<id>:deleteUser`, `user:create:<email>` |
| `AuthController` | `auth:<id>:changePassword`, `user:<id>:changeColor` |

Keys include the operation name, so different operations on the same path can
still run in parallel when they come from different clients; only identical
operations on one resource are mutually exclusive. The rename key uses only one
path, because taking locks on both the source and the destination could
deadlock.

### The vault gene

`Gene` has its own queue (`vault-gene`) with a read key and an update key.
Before queuing an update it checks `queue.getTaskIdentifiers` and skips the
update if one is already waiting, since that one will rescan the vault anyway.

### Plugin

The plugin uses the same classes, with the plugin's `clientId` as queue id:

- `SyncVaultChanges` queues each local vault event (`local:<path>:<type>`), so
  the server receives them in the order Obsidian fired them.
- `RemoteVaultChangeService` queues each `/system` event
  (`remote:<path>:<type>`).
- `ZipWorkerSon` writes the initial download as one task (`vault:initialSync`).

Because local and remote operations share the client's queue, a remote change
is never applied halfway through publishing a local one.

## The room message queue

Collaboration rooms use a lighter variant: one promise chain per `YjsRoom`
(`room.messageQueue`), without `Queue` or `KeyedLock`. The room protects a
single object, its `Y.Doc`, and nobody waits for a result, so a plain chain
is enough.

```ts
const task = room.messageQueue.then(async () => {
  await room.ready;
  if (this.#connectionState.closed) return;
  this.#processMessage(message);
});
room.messageQueue = task.catch(/* close the sender */).finally(/* pendingMessages -= 1 */);
```

Every connection's `YjsConnectionSession` holds a reference to the same room
object, so all of them read and replace the same `messageQueue`. Messages from
different users interleave in arrival order:

```text
Promise.resolve() ─▶ Ana: update ─▶ Beto: awareness ─▶ Ana: update
                                                          ▲
                                                 room.messageQueue
```

The first message waits for `room.ready` (the state loading from disk); every
later message waits for the one before it. When the room is idle, the tail is
an already resolved promise, so a new message runs almost immediately. The
same code handles both cases without checking whether the queue is empty.

`#processMessage()` is synchronous, so once `ready` has resolved the event loop
alone would keep the order. The chain matters for two things: holding messages
back while the room loads, and letting room shutdown `await room.messageQueue`
to apply every pending message before the final write.

A chain has no length, so `room.pendingMessages` counts the unfinished links to
enforce the limit of 1,024.

## What is not serialized

`YjsPersistence` serializes writes per document with its own mechanism
(`state.writing` and a dirty flag) and does not take the shared `KeyedLock`.
Its writes to `data/vault/<path>.md` can therefore overlap with HTTP file
operations on the same path. See
[Known issues](known-issues.md#yjs-persistence-is-outside-the-keyedlock).

## Related pages

- [File synchronization](file-sync.md)
- [Collaboration](collaboration.md)
- [Backend services reference](reference/backend/services.md#queue-queuemanager-and-keyedlock)
