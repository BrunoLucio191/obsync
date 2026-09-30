# Backend service API

## DBServices

The user-domain layer over SQLite. It normalizes input, enforces unique e-mail
and name and the last-admin rule, and emits `authorization-changed` after
mutations that affect what a user may do.

Source: [`backend/users/DBServices.ts`](../../../backend/users/DBServices.ts)

```ts
new DBServices(userDB: UserDB)
```

| Method | Result | Description |
| --- | --- | --- |
| `isUserRole(value)` | type predicate | Accepts only `admin` or `user` |
| `runImmediateTransaction(operation)` | generic | Runs a synchronous `BEGIN IMMEDIATE` transaction |
| `rowToUser(row)` | `AuthenticatedUser` | Converts SQLite fields and validates the stored role |
| `getUserById(id, includeInactive?)` | user or `null` | Excludes inactive accounts by default |
| `listUsers()` | user array | Active and inactive users, by id |
| `createUser(name, email, password, role?)` | `CreateUserResult` | Hashes the password, picks a random cursor color |
| `updateUserName(id, name)` | `UserMutationResult` | Emits `authorization-changed` |
| `updateUserColor(id, color)` | `UserMutationResult` | Does **not** emit: color is not an authorization change, so live sockets stay open |
| `updateUserRole(id, role)` | `UserMutationResult` | Refuses to demote the last active admin; emits |
| `updateUserStatus(id, active)` | `UserMutationResult` | Refuses to deactivate the last active admin; emits |
| `updateUserPassword(id, currentPassword, newPassword)` | `UserMutationResult` | Verifies the current password first |
| `adminSetUserPassword(id, newPassword)` | `UserMutationResult` | No current password; the controller restricts it to `user` targets |
| `deleteUser(id)` | `UserMutationResult` | Refuses to delete the last active admin; emits |

## ExpressServer

Owns the Express app and the Node HTTP server, defines the three middlewares,
builds the routers and controllers, and mounts each router. It has no route
handlers of its own.

Source: [`backend/Server/ExpressServer/ExpressServer.ts`](../../../backend/Server/ExpressServer/ExpressServer.ts)

```ts
new ExpressServer({
  port, host, requireTls, trustProxy,
  fileManager, tokenService, dbService, authService,
  collaborationServer, keyedLock, vaultGene,
})
```

| Member | Description |
| --- | --- |
| `initializeMiddleware()` | TLS enforcement (`426`), JSON parsing (25 MB), `Cache-Control: no-store` on `/api/auth`, router mounting |
| `serverStart(port?)` | Starts listening on the configured host |
| `getHttpServer` | The underlying `node:http` server, used for WebSocket upgrades |
| `#requireAuth` | Bearer token → `res.locals.authenticatedUser` and `res.locals.accessToken`; `401` otherwise |
| `#requireAdmin` | `403` and an audit log unless the current user is an admin |
| `#requireClientId` | `X-ObSync-Client` header → `res.locals.clientId`; `400` otherwise |

The constructor creates a separate `QueueManager` for each controller, all over
the same `KeyedLock`, and three `LoginRateLimiter` instances (account 5, IP 25,
password change 5).

## Routers

Each router class owns an `express.Router`, receives the middlewares and its
controller in the constructor, and registers routes in `startRoute()`. Paths
are relative to the mount prefix. The full route list is in
[HTTP API](http.md).

| Class | Source | Mounted at |
| --- | --- | --- |
| `RouteAuth` | [`routes/route.auth.ts`](../../../backend/Server/ExpressServer/routes/route.auth.ts) | `/api/auth` |
| `RouteUsers` | [`routes/route.users.ts`](../../../backend/Server/ExpressServer/routes/route.users.ts) | `/api/users` |
| `RouteSyncFiles` | [`routes/route.syncFiles.ts`](../../../backend/Server/ExpressServer/routes/route.syncFiles.ts) | `/api/sync` |

## Controllers

Handlers are arrow-function properties, so they keep `this` when Express calls
them. Mutations run inside `queue.addTask()` on the caller's client-id queue.

| Class | Handlers |
| --- | --- |
| `AuthController` | `login`, `refreash` (refresh), `logout`, `me`, `wsTicket`, `changePassword`, `changeColor` |
| `UsersController` | `listUsers`, `createUser`, `renameUser`, `changePassword`, `changeRole`, `changeStatus`, `deleteUser` |
| `SyncFilesController` | `initSync`, `create`, `delete`, `modify`, `rename`, `createFile`, `getFile` |

`routes/mutationMessage/userMessageMutation.ts` provides
`userMutationErrorStatus(result)` and `UserMutationErrorMessage(result)`, which
turn a failed `UserMutationResult` into an HTTP status and message.

## WebSocketServer

The exported class wraps two `ws` servers (imported as `WsServer`, because `ws`
also exports a class named `WebSocketServer`).

Source: [`backend/Server/WebSocketServer.ts`](../../../backend/Server/WebSocketServer.ts)

```ts
new WebSocketServer(server, tokenService, requireTls, trustProxy, collaborationServer)
```

| Member | Description |
| --- | --- |
| `wssSystem` | `/system`: receive-only vault events |
| `wssYjs` | Every other path: one Yjs room per note |
| `initializeWebSockets()` | Creates `YjsPersistence` and attaches it, installs connection handlers, forwards `vaultEvents` to `/system`, starts the heartbeat |

Behavior worth knowing:

- Both servers use `noServer: true`; the only way in is `#handleUpgrade`, which
  checks TLS, reads the ticket from `Sec-WebSocket-Protocol` and consumes it.
- A timer closes each socket with `4003` when its access token expires.
- The constructor subscribes to session revocations and
  `authorization-changed` events and closes the affected sockets with `4003`.
- The heartbeat pings every 30 s and terminates sockets that did not answer the
  previous ping.

## YjsCollaborationServer

Entry point of the collaboration backend. It owns a `YjsRoomRegistry`,
`YjsPersistenceGateway`, `DeletedPathRegistry`, `AwarenessOwnershipGuard` and
the `syncMessageHandler` function.

Source: [`backend/yjs/YjsCollaborationServer.ts`](../../../backend/yjs/YjsCollaborationServer.ts)

| Method | Description |
| --- | --- |
| `setPersistence(adapter)` | Attaches the persistence adapter; until then every persistence call is a no-op |
| `setupConnection(connection, request, user)` | Parses the note path, reserves a room, builds `YjsConnectionState`, sends the initial sync |
| `isPathDeleted(path)` | Whether the path or an ancestor is marked deleted |
| `isDocumentInvalidated(doc)` | Whether a document was invalidated by a deletion |
| `markPathDeleted(path)` | Marks the path deleted and closes every room under it with `1008` |
| `clearPathDeleted(path)` | Clears the mark, and marks above or below it (a recreated file) |
| `deletePersistedStateUnderPath(path)` | Removes `.yjs-state` for a note or folder |
| `renamePersistedStatePath(oldPath, newPath)` | Moves `.yjs-state` with a vault rename |

Internal collaborators in `backend/yjs/`:

| Class or function | Role |
| --- | --- |
| `YjsRoomRegistry` | `reserve()`, `release()`, `invalidateUnderPath()`; creates rooms and runs their shutdown |
| `YjsRoom` | `doc`, `awareness`, `connections`, `awarenessOwners`, `ready`, `messageQueue`; `broadcast()`, `sendInitialSync()` |
| `YjsConnectionSession` | `handleRawMessage()`: binary check, room queue, dispatch by message type |
| `syncMessageHandler` | Sync steps; drops writes when `canWriteGlobal` is false |
| `AwarenessOwnershipGuard` | Filters awareness entries by authenticated identity and ownership |
| `DeletedPathRegistry` | Deleted roots and invalidated documents |
| `YjsPersistenceGateway` | Optional-adapter wrapper |
| `yjsUtils/*` | Path parsing and normalization, presence identity, WebSocket send/close helpers |

## YjsPersistence

Stores each note's binary Yjs state (the authority) and its Markdown text.

Source: [`backend/Server/YjsPersistence.ts`](../../../backend/Server/YjsPersistence.ts)

```ts
new YjsPersistence(vaultPath: string, statePath: string, collaborationServer: YjsCollaborationServer)
```

| Method | Description |
| --- | --- |
| `bindState(docName, ydoc)` | Loads `.yjs-state`, or seeds from the `.md` file; then saves on every update |
| `writeState(docName, ydoc)` | Forces a flush (used when a room closes) |
| `destroyState(docName, ydoc)` | Waits for a running write and stops observing the document |
| `deleteStateUnderPath(path)` | Removes one note's state or a folder subtree |
| `renameStatePath(oldPath, newPath)` | Moves state files and folders |

Writes are serialized per document, coalesced while a write is running, skipped
for deleted paths, and atomic (temporary file and rename). See
[Collaboration](../../collaboration.md#persistence-backendserveryjspersistencets).

## FileManager

Every filesystem operation on the shared vault. Each relative path is resolved
under `data/vault/`; absolute paths and paths that resolve outside it throw.

Source: [`backend/Server/FileManager.ts`](../../../backend/Server/FileManager.ts)

| Method | Description |
| --- | --- |
| `createOrModifyFile(path, content)` | Creates parent folders and writes a string or `Buffer` |
| `stringToFile(content, name)` | Wrapper around `createOrModifyFile()` |
| `createFolder(path)` | Recursive `mkdir` |
| `deletePath(path)` | Recursive delete of a file or folder |
| `rename(oldPath, newPath)` | Returns `"moved"`, `"already-applied"` (only the destination exists) or `"not-found"` |
| `getFilePath(path)` | Absolute path of an existing file, or `null` (folders, missing, outside the vault) |
| `isFolder(path)` | Whether the path is an existing folder |
| `directoryZiped(zipDir, clientId)` | Writes `<zipDir>/<clientId>.zip` of the vault, skipping hidden files |

## Gene

Maintains `data/gene.json`, the vault fingerprint used by `initSync`.

Source: [`backend/Server/Gene.ts`](../../../backend/Server/Gene.ts)

```ts
new Gene(vaultDirectory: string, genePath: string, queueManager: QueueManager)
```

| Method | Description |
| --- | --- |
| `mutateVaultGene()` | Starts a recursive `fs.watch` on the vault; every event queues an update |
| `readGene()` | The gene as a JSON string, read in the gene queue; `null` if missing or invalid |
| `makeNewGene()` | Writes an empty gene |
| `getBytesAndNumOfFiles()` | Total size and count of non-empty files |
| `compareGenes(a, b)` | Constant-time comparison of two gene objects |

An update increments `generation`, recomputes `bytes` and `filesCount`, and
sets `lastModification`. At most one update waits in the queue at a time.

## Queue, QueueManager and KeyedLock

Source: [`backend/queue/`](../../../backend/queue/). The plugin has identical
copies in `plugin/obSync/src/queue/`. The concepts are explained in
[Concurrency](../../concurrency.md).

### KeyedLock

```ts
new KeyedLock()
run<T>(operation: () => Promise<T>, key: string): Promise<T>
busyKeys: number
```

`run()` waits until no earlier operation with the same key is running, runs
`operation`, and releases the key even if it throws.

### Queue

```ts
new Queue(lock: KeyedLock, onEmpty?: () => void)
addTask<T>(task: () => Promise<T>, taskKey: string): Promise<T>
numberOfTaks: number            // waiting tasks
getTaskIdentifiers: string[]    // keys of waiting tasks
isProcessing: boolean
```

Runs tasks one at a time in arrival order, each through `lock.run(task, key)`.
The promise returned by `addTask()` settles with the task's own result. A
failing task is logged and does not stop the queue.

### QueueManager

```ts
new QueueManager(lock: KeyedLock)
getOrCreateQueue(id: string): Queue
```

One `Queue` per id, removed when it drains. Add the task immediately after
getting the queue; do not keep the queue object across an `await`.

## Database lifecycle

Source: [`backend/users/databaseLifecycle.ts`](../../../backend/users/databaseLifecycle.ts)

```ts
openUserDatabase(databasePath: string): UserDB
createUserDatabase(databasePath: string): Promise<void>
```

`openUserDatabase()` requires an existing file with a `users` table and an
active admin, and throws an error naming `npm run db:setup` otherwise.
`createUserDatabase()` refuses an existing file, creates the schema and seed,
and removes the partial file and its WAL/SHM sidecars on failure.

## ServerConfig

Source: [`backend/serverConfig.ts`](../../../backend/serverConfig.ts)

```ts
loadServerConfig(environment = process.env): ServerConfig
```

Parses host, port, TLS, proxy trust and the signing secret. Throws when TLS is
off on a non-loopback host, or when TLS is required without proxy trust. The
secret length is checked by `TokenService`.
