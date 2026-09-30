# Architecture

Both halves of ObSync follow the same shape: one composition root builds every
service and passes each one its dependencies through the constructor. Nothing
reaches for a global instance, so reading a constructor tells you everything a
class can touch. This page lists the modules, what each one owns, and the
reasons behind the less obvious boundaries.

For method signatures, see the [API reference](reference/README.md).

## Conventions used across the codebase

- **`#` private fields**, not the TypeScript `private` keyword, for class
  members. They are enforced at runtime, not only by the compiler.
- **Constructor injection.** Services receive collaborators as constructor
  arguments. The only exception is `SyncVaultChanges`, which needs the
  `Plugin` instance to register vault events with Obsidian's lifecycle.
- **Bracketed log prefixes** in the backend (`[Yjs]`, `[Sync]`, `[Audit]`,
  `[Users]`...), naming the module a message came from.
- **Result objects instead of exceptions** for expected failures, for example
  `UserMutationResult` (`{ ok: true, user }` or `{ ok: false, reason }`) in the
  backend and `UserActionResult<T>` in the plugin.
- **No backward compatibility code.** ObSync is in development; the SQLite file
  and all runtime data are disposable, so there are no migrations.

## Backend

### Composition (`backend/main.ts`)

```ts
const config = loadServerConfig();                           // env vars, TLS rules
const userDB = openUserDatabase(systemPaths.usersDatabase);  // refuses a missing or invalid DB
const dbService = new DBServices(userDB);
const tokenService = new TokenService({ secret: config.tokenSecret, dbService });
const authService = new AuthService(userDB, dbService, tokenService);
const collaborationServer = new YjsCollaborationServer();
const keyedLock = new KeyedLock();                           // one lock shared by every queue
const vaultGene = new Gene(systemPaths.vault, systemPaths.vaultGene, new QueueManager(keyedLock));

const server = new ExpressServer({ ..., collaborationServer, keyedLock, vaultGene });
server.serverStart();
vaultGene.mutateVaultGene();                                 // starts watching data/vault/
const webSocketServer = new WebSocketServer(server.getHttpServer, tokenService, ..., collaborationServer);
webSocketServer.initializeWebSockets();                      // also wires YjsPersistence
```

Two instances are deliberately shared:

- **`TokenService`** is used by the HTTP middleware and by the WebSocket
  upgrade handler. A ticket issued over HTTP can only be consumed on upgrade
  because both read the same in-memory maps.
- **`YjsCollaborationServer`** is used by the HTTP file routes and by the
  WebSocket server, so a delete or rename over HTTP immediately affects the
  live collaboration rooms and their stored state.

### HTTP layer (`backend/Server/ExpressServer/`)

The HTTP layer is split in three levels:

| Level | Files | Owns |
| --- | --- | --- |
| App | `ExpressServer.ts` | TLS enforcement, JSON parsing, the three middlewares, mounting routers |
| Routes | `routes/route.auth.ts`, `route.users.ts`, `route.syncFiles.ts` | URL, HTTP method and middleware chain of each endpoint |
| Controllers | `controllers/AuthController.ts`, `UsersController.ts`, `SyncFilesController.ts` | Input validation, the queued operation, the response |

The three middlewares are defined once in `ExpressServer` and passed into each
router:

- `#requireAuth` reads `Authorization: Bearer <token>`, calls
  `TokenService.verifyToken()`, and stores the current user (reloaded from
  SQLite) in `res.locals.authenticatedUser`.
- `#requireAdmin` rejects non-admins with `403` and writes an audit log.
- `#requireClientId` requires the `X-ObSync-Client` header and stores it in
  `res.locals.clientId`. Every mutating route needs it, because the client id
  selects the queue the operation runs on and becomes `originClientId` on
  broadcasts.

Routers are mounted with a prefix (`/api/auth`, `/api/users`, `/api/sync`), so
paths inside a router are relative: `RouteUsers` registers `/:id/name`, not
`/api/users/:id/name`.

`routes/mutationMessage/userMessageMutation.ts` maps a
`UserMutationResult.reason` to an HTTP status and an English message, so every
controller answers the same failure the same way.

### Backend modules

| Module | Responsibility |
| --- | --- |
| `serverConfig.ts` | Reads `OBSYNC_HOST`, `PORT`, `OBSYNC_REQUIRE_TLS`, `OBSYNC_TRUST_PROXY`, `OBSYNC_TOKEN_SECRET`; refuses unsafe combinations |
| `env.ts` | Loads `backend/.env` if present (imported for its side effect) |
| `paths.ts` | Absolute paths of everything under `backend/data/`, resolved from the backend folder so the working directory does not matter |
| `auth/TokenService.ts` | Sessions, access tokens (signed JWT), refresh tokens, WebSocket tickets, revocation |
| `auth/authService.ts` | Login: loads the user row and checks the password |
| `auth/LoginRateLimiter.ts` | Sliding-window failure counter per key (account, IP, password change) |
| `auth/PasswordUtil.ts` | scrypt hashing and constant-time comparison |
| `users/UserDB.ts` | `node:sqlite` database: schema, seed, runtime validation |
| `users/DBServices.ts` | User queries and mutations, last-admin protection, authorization-change events |
| `users/DBEvents.ts` | Event emitter that tells the WebSocket server a user's role or status changed |
| `users/databaseLifecycle.ts` | `createUserDatabase()` for setup, `openUserDatabase()` for startup |
| `users/userColor.ts` | Default cursor colors and `#rrggbb` validation |
| `Server/FileManager.ts` | Every filesystem operation on `data/vault/`, with path-traversal protection, plus the ZIP export |
| `Server/Gene.ts` | The vault gene: a small JSON fingerprint of the vault, used to skip unnecessary initial downloads |
| `Server/WebSocketServer.ts` | Upgrade authentication, `/system` broadcasts, `/yjs` connections, heartbeat, closing sockets on revocation |
| `Server/YjsPersistence.ts` | Stores each note twice: binary Yjs state and the Markdown file |
| `syncEvents.ts` | `VaultChange` type and the in-process event emitter the controllers publish to |
| `yjs/YjsCollaborationServer.ts` | Public entry point of the collaboration backend |
| `yjs/yjsRooms/YjsRoomRegistry.ts` | Creates, reuses and tears down rooms |
| `yjs/yjsRooms/YjsRoom.ts` | One note: its `Y.Doc`, awareness, connections and message queue |
| `yjs/YjsConnectionSession.ts` | Per-socket message intake: queueing and dispatch by message type |
| `yjs/SyncMessageHandler.ts` | Yjs sync protocol steps and the admin-only write check |
| `yjs/AwarenessOwnershipGuard.ts` | Stops a connection from faking or removing another user's cursor |
| `yjs/DeletedPathRegistry.ts` | Remembers deleted paths so stale rooms and late writes can be refused |
| `yjs/YjsPersistenceGateway.ts` | Forwards to the persistence adapter, or does nothing until one is set |
| `queue/Queue.ts`, `QueueManager.ts`, `KeyedLock.ts` | Operation ordering; see [Concurrency](concurrency.md) |
| `scripts/setupDatabase.ts` | `npm run db:setup` entry point |
| `scripts/generateRandomVault.ts` | Fills `data/vault/` with random folders and notes for manual testing |

### Why the Yjs backend is split into many small classes

It used to be one module with module-level state mixing room lifecycle,
persistence, protocol handling and awareness validation. The current split
gives each concern one owner, and `YjsCollaborationServer` is the only class
the rest of the server talks to. `syncMessageHandler` is a plain function, not
a class, because it holds no state between calls.

## Plugin

### Composition (`plugin/obSync/src/main.ts`)

`ObSync` (the `Plugin` subclass) builds the services in `#composeServices()`:

```text
ObSync
├── AuthService ── UserAdminService
├── PathMuteRegistry                     shared by everything that writes to the vault
├── CollaborationController              one Yjs room for the active note
├── QueueManager(new KeyedLock())        client-side operation ordering
├── ServerVersionMerger ── SyncBaseStore regular users only: merge server versions
├── RemoteVaultChangeService             applies /system events
├── SystemChannel                        the /system WebSocket
├── SyncInitialVault ── Boss ── ZipWorkerSon ── Web Worker
├── SyncVaultChanges                     admins only: publishes local vault events
└── ObSyncSettingTab                     talks to ObSync through the SettingsController interface
```

Synchronization starts only after Obsidian's layout is ready and a session
exists (`#initializeSynchronization()`). If no backend URL is configured, the
plugin does nothing at startup, so it never opens a login prompt for a backend
that does not exist.

### Plugin modules

| Module | Responsibility |
| --- | --- |
| `auth/AuthService.ts` | Login, token refresh (single-flight), `SecretStorage`, role checks, request headers, WebSocket tickets |
| `auth/UserAdminService.ts` | Typed HTTP client for `/api/users` |
| `auth/LoginModal.ts` | Sign-in dialog |
| `config/ApiConfig.ts` | Validates the backend URL and derives the WebSocket URL, kept in memory |
| `config/ObSyncConfig.ts` | Shape of `data.json`: backend URL, current user, token expiry |
| `collab/CollaborationController.ts` | Follows the active Markdown file; joins and leaves rooms; installs the editor extension |
| `collab/collab.ts` | Builds a room: `Y.Doc`s, IndexedDB cache, `WebsocketProvider`, awareness, ticket reconnects |
| `collab/OfflinePersistence.ts` | IndexedDB database naming and lifecycle for a `Y.Doc` |
| `sync/SyncInitialVault.ts` | Starts the initial download |
| `Workers/Boss.ts`, `Workers/zipWorker/ZipWorkerSon.ts` | Downloads the vault ZIP (main thread), hands it to the Worker, writes the result |
| `Workers/zipWorker/zip.worker.ts` | Runs inside a Web Worker; only unzips |
| `sync/SyncVaultChanges.ts` | Publishes an admin's local create, modify, delete and rename events |
| `sync/SystemChannel.ts` | `/system` WebSocket with ticket reconnects and backoff |
| `vault/RemoteVaultChangeService.ts` | Applies `/system` events to the local vault |
| `vault/ServerVersionMerger.ts` | Regular users: three-way merge of server versions into local files |
| `vault/SyncBaseStore.ts` | Regular users: stores the last server version of each file (the merge base) |
| `vault/PathMuteRegistry.ts` | Paths the plugin is writing itself, so the resulting vault events are not published back |
| `vault/binaryExtensions.ts` | Which extensions are treated as binary |
| `queue/*` | Same Queue/KeyedLock design as the backend |
| `settings/*` | Settings tab sections |
| `i18n/*` | `t()` lookup, `en` and `pt` dictionaries, backend error localization |

### Why the Web Worker is compiled into a string

Obsidian loads a single `main.js`, and there is no reliable file path to give
`new Worker(...)`, especially on mobile. `esbuild.config.mjs` therefore builds
`zip.worker.ts` first and writes the bundled code as a string into
`zip.worker.generated.ts`. `ZipWorkerSon` turns that string into a Blob URL and
starts the Worker from it. The generated file is git-ignored, which is why the
first build on a fresh clone needs an extra step (see the
[README](../README.md#getting-started)).

The Worker only unzips. It has no access to the Obsidian API, so the main
thread writes the files.

### `collab.ts` is a module with state

Unlike the rest of the plugin, `collab.ts` is a set of functions over a
module-level `activeRoom` variable and an `ActiveRoom` object that every
function receives. It behaves like a class without being one. This is a known
inconsistency, listed in [Known issues](known-issues.md#collabts-keeps-state-at-module-level).

## Communication channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| `POST /api/auth/login`, `/refresh`, `/logout` | client ↔ server | Session lifecycle |
| `GET /api/auth/me` | client ← server | Current profile, reloaded from SQLite |
| `POST /api/auth/ws-ticket` | client ← server | One-use, channel-scoped WebSocket ticket |
| `POST /api/auth/change-password`, `PATCH /api/auth/color` | client → server | Self-service account changes |
| `/api/users/*` | admin ↔ server | User administration |
| `POST /api/sync/initSync` | client ← server | Whole vault as a ZIP, skipped when the gene matches |
| `GET /api/sync/getFile` | client ← server | One file, used for binaries and renamed files |
| `/api/sync/create`, `/modify`, `/delete`, `/rename`, `/createFile` | admin → server | Vault mutations |
| WSS `/system` | server → client | `VaultChange` broadcasts; any client message closes the socket |
| WSS `/<encoded note path>` | client ↔ server | Yjs sync and awareness for one note |

Full contracts: [HTTP API](reference/backend/http.md) and
[WebSocket API](reference/backend/websocket.md).
