# Backend service API

## DBServices

`DBServices` is the user-domain layer over SQLite. It normalizes input,
maintains last-admin rules, and emits authorization-change events after a
successful mutation.

Source: [`backend/users/DBServices.ts`](../../../backend/users/DBServices.ts)

```ts
new DBServices(userDB: UserDB)
```

| Method | Result | Description |
| --- | --- | --- |
| `isUserRole(value)` | type predicate | Accepts only `admin` or `user` |
| `runImmediateTransaction(operation)` | generic result | Runs a synchronous `BEGIN IMMEDIATE` transaction |
| `rowToUser(row)` | `AuthenticatedUser` | Converts SQLite fields and validates the stored role |
| `getUserById(id, includeInactive?)` | user or `null` | Excludes inactive accounts by default |
| `listUsers()` | user array | Lists active and inactive users by ID |
| `createUser(name, email, password, role?)` | `CreateUserResult` | Hashes the password and enforces unique email and name |
| `updateUserName(id, name)` | `UserMutationResult` | Normalizes and updates a unique display name |
| `updateUserRole(id, role)` | `UserMutationResult` | Prevents demotion of the last active admin |
| `updateUserStatus(id, active)` | `UserMutationResult` | Prevents deactivating the last active admin |
| `deleteUser(id)` | `UserMutationResult` | Prevents deleting the last active admin |

## ExpressServer

`ExpressServer` configures middleware and exposes the HTTP API.

Source: [`backend/Classes/ExpressServer.ts`](../../../backend/Classes/ExpressServer.ts)

```ts
new ExpressServer({
	port,
	host,
	requireTls,
	trustProxy,
	fileManager,
	tokenService,
	dbService,
	authService,
})
```

| Member | Description |
| --- | --- |
| `initializeMiddleware()` | Installs TLS enforcement, JSON parsing, and a no-store header on `/auth` routes |
| `serverStart(port?)` | Starts the Node HTTP server on the configured host |
| `getHttpServer` | Returns the underlying `node:http` server for WebSocket upgrades |

Routes are documented in [HTTP API](http.md).

## WebSHocket

`WebSHocket` is the exported WebSocket transport class. The spelling is the
current code symbol and must be used exactly in imports.

Source: [`backend/Classes/WebSocketServer.ts`](../../../backend/Classes/WebSocketServer.ts)

```ts
new WebSHocket(
	server: Server,
	tokenService: TokenService,
	requireTls: boolean,
	trustProxy: boolean,
)
```

| Member | Type | Description |
| --- | --- | --- |
| `wssSystem` | `WebSocketServer` | Receive-only vault-event server |
| `wssYjs` | `WebSocketServer` | Collaborative Yjs server |
| `initializeWebSockets()` | method | Installs persistence, connection handlers, event broadcasting, and heartbeat |

Upgrade behavior and close codes are documented in
[WebSocket API](websocket.md).

## FileManager

`FileManager` performs shared-vault filesystem operations. Every relative path
is resolved under the configured vault root; absolute paths and traversal
outside that root are rejected.

Source: [`backend/Classes/FileManager.ts`](../../../backend/Classes/FileManager.ts)

| Method | Description |
| --- | --- |
| `stringToFile(content, name)` | Compatibility wrapper for `createOrModifyFile()` |
| `createOrModifyFile(path, content)` | Creates parent folders and writes UTF-8 content |
| `createFolder(path)` | Recursively creates a folder |
| `deletePath(path)` | Recursively removes a file or folder |
| `rename(oldPath, newPath)` | Creates the destination parent and renames the path |
| `directoryZiped()` | Writes a ZIP snapshot used by initial sync |

## YjsPersistence

`YjsPersistence` keeps each shared Yjs document and its Markdown snapshot in
sync.

Source: [`backend/Classes/YjsPersistence.ts`](../../../backend/Classes/YjsPersistence.ts)

```ts
new YjsPersistence(vaultPath: string, statePath: string)
```

| Method | Description |
| --- | --- |
| `bindState(docName, ydoc)` | Restores binary state or bootstraps from Markdown, then observes updates |
| `writeState(docName, ydoc)` | Marks the document dirty and flushes state |
| `destroyState(docName, ydoc)` | Waits for writes, removes listeners, and releases tracking |
| `deleteStateUnderPath(path)` | Removes one note state or a complete folder subtree |
| `renameStatePath(oldPath, newPath)` | Moves state files and directories with their vault path |

Writes are serialized per document. A flush saves a consistent Yjs binary
state and the current `codemirror` text.

## Database lifecycle

Source: [`backend/users/databaseLifecycle.ts`](../../../backend/users/databaseLifecycle.ts)

### `openUserDatabase()`

```ts
openUserDatabase(databasePath: string): UserDB
```

Opens an existing database and validates it for runtime use. It throws an
instructional error when the file is missing or invalid; startup never creates
the database implicitly.

### `createUserDatabase()`

```ts
createUserDatabase(databasePath: string): Promise<void>
```

Creates schema and seed data only when the target file does not exist. Failed
setup removes the incomplete database and its SQLite sidecar files.

## ServerConfig

Source: [`backend/serverConfig.ts`](../../../backend/serverConfig.ts)

```ts
loadServerConfig(environment = process.env): ServerConfig
```

Parses host, port, TLS, proxy trust, and signing secret. Plaintext on a
non-loopback host is rejected, and proxy-terminated TLS requires explicit proxy
trust.
