# Architecture

This page maps responsibilities and dependency direction. For individual
constructors, methods, parameters, and return values, use the
[API reference](reference/README.md).

## Plugin structure

The plugin follows the same composition-oriented structure as the backend.
`main.ts` is the composition root: it loads configuration, constructs the
objects, connects their dependencies, and controls their lifecycle. Business
rules and integration details live in dedicated classes instead of the plugin
entry point.

```text
plugin/obSync/src/
├── main.ts                         plugin composition and lifecycle
├── auth/
│   ├── AuthService.ts              login, session, role, and auth headers
│   ├── UserAdminService.ts         user-management API
│   ├── LoginModal.ts               login UI
│   └── auth.types.ts               authentication domain types
├── collab/
│   ├── CollaborationController.ts  active-note room lifecycle
│   ├── OfflinePersistence.ts       per-user IndexedDB persistence
│   └── collab.*                    low-level Yjs and awareness protocol
├── config/
│   ├── ApiConfig.ts                runtime backend endpoint (set from settings, not build)
│   └── ObSyncConfig.ts            persisted plugin configuration
├── i18n/
│   ├── i18n.ts                     i18next setup and Obsidian-locale detection
│   ├── backendErrors.ts            maps backend `reason` codes to localized text
│   └── locales/                    en.ts and pt.ts translation dictionaries
├── settings/
│   ├── ObSyncSettingTab.ts        settings composition
│   ├── BackendConnectionSection.ts backend URL field (currently editable by any role)
│   ├── AccountSettingsSection.ts   current-account UI
│   ├── UserManagementSection.ts    user-management composition
│   └── users/                      create, list, cache, and name editor
├── sync/
│   ├── SystemChannel.ts            server-to-client vault events
│   ├── SyncInitialVault.ts         initial shared-vault download
│   └── SyncVaultChanges.ts         admin-only local change publisher
└── vault/
    ├── RemoteVaultChangeService.ts remote change application
    ├── PathMuteRegistry.ts         local event-loop suppression
    └── VaultChange.ts              vault-event types
```

## Plugin responsibilities

| Module | Responsibility |
| --- | --- |
| `plugin/obSync/src/main.ts` | Constructs services and starts or stops the plugin lifecycle |
| `plugin/obSync/src/auth/AuthService.ts` | Owns login, token validation, session refresh, current user, and role checks |
| `plugin/obSync/src/auth/UserAdminService.ts` | Encapsulates user-list and user-mutation HTTP requests |
| `plugin/obSync/src/collab/CollaborationController.ts` | Selects the active Markdown room and manages editor extensions and reconnection |
| `plugin/obSync/src/collab/collab.ts` | Implements Yjs documents, provider wiring, awareness, and role-specific document ownership |
| `plugin/obSync/src/collab/OfflinePersistence.ts` | Owns IndexedDB database naming, loading, and lifecycle |
| `plugin/obSync/src/sync/SystemChannel.ts` | Receives shared-vault changes from the backend |
| `plugin/obSync/src/sync/SyncInitialVault.ts` | Initial shared-vault download |
| `plugin/obSync/src/sync/SyncVaultChanges.ts` | Admin-only file create, modify, delete, and rename requests |
| `plugin/obSync/src/vault/RemoteVaultChangeService.ts` | Applies server events to the local vault without creating publish loops |
| `plugin/obSync/src/vault/PathMuteRegistry.ts` | Temporarily marks remote paths so Obsidian events are not sent back to the server |
| `plugin/obSync/src/settings/ObSyncSettingTab.ts` | Composes the backend-connection, account, and user-management settings sections |
| `plugin/obSync/src/settings/BackendConnectionSection.ts` | Backend URL field: the admin-only gate after sign-in is currently disabled (`canEdit` is hardcoded `true`), so the field stays editable for every role |
| `plugin/obSync/src/config/ApiConfig.ts` | Holds the resolved backend endpoint in memory; every plugin install ships the same build, and each user configures their own URL at runtime |
| `plugin/obSync/src/settings/users/*` | Separates the user directory, creation form, list actions, and debounced name updates |
| `plugin/obSync/src/i18n/i18n.ts` | Initializes i18next with the `en`/`pt` dictionaries, chosen from Obsidian's own configured language (`moment.locale()`), not the OS locale |
| `plugin/obSync/src/i18n/backendErrors.ts` | Maps a structured-mutation endpoint's `reason` code to a localized message, falling back to the backend's English text for codes it doesn't recognize |

## Dependency direction

```text
ObSync (composition root)
  ├── AuthService ── UserAdminService
  ├── CollaborationController ── Yjs/IndexedDB helpers
  ├── SystemChannel ── RemoteVaultChangeService
  ├── SyncInitialVault
  ├── SyncVaultChanges
  └── ObSyncSettingTab ── SettingsController interface
```

Services receive their dependencies through constructors. They do not receive
the complete `ObSync` object, except where the Obsidian `Plugin` lifecycle API
is explicitly required to register vault events. The settings sections depend
on `SettingsController`, so their code is not coupled to the concrete plugin
entry class.

The plugin's low-level Yjs protocol helpers (`collab/collab.ts` and
`collab/collab.utils.ts`) remain functions over a single active-room variable.
There is only ever one editor open at a time, so a class would add indirection
without creating a useful object boundary.

## Backend modules

| Module | Responsibility |
| --- | --- |
| `backend/main.ts` | Application composition and startup |
| `backend/Server/ExpressServer/ExpressServer.ts` | Express app setup: mounts each router, no route handlers of its own |
| `backend/Server/ExpressServer/routes/route.auth.ts` | `/api/auth/*` routes and their authorization |
| `backend/Server/ExpressServer/routes/route.users.ts` | `/api/users/*` routes and their authorization |
| `backend/Server/ExpressServer/routes/route.syncFiles.ts` | `/api/sync/*` routes and their authorization |
| `backend/Server/WebSocketServer.ts` | WebSocket upgrade authentication and channel routing |
| `backend/yjs/YjsCollaborationServer.ts` | Composition root for the Yjs backend: wires the room registry, persistence gateway, and message handlers, and exposes the public API used by `ExpressServer` and `WebSocketServer` |
| `backend/yjs/yjsRooms/YjsRoomRegistry.ts` | Shared-room lifecycle: reservation, creation, cleanup, and path invalidation |
| `backend/yjs/yjsRooms/YjsRoom.ts` | One shared Yjs document: connections, awareness state, and broadcast |
| `backend/yjs/YjsConnectionSession.ts` | Per-connection message queue and dispatch |
| `backend/yjs/SyncMessageHandler.ts` | Plain `syncMessageHandler()` function implementing Yjs sync-protocol steps and write-permission enforcement |
| `backend/yjs/AwarenessOwnershipGuard.ts` | Awareness update validation and per-client ownership |
| `backend/yjs/DeletedPathRegistry.ts` | Tracks deleted vault paths and invalidated documents |
| `backend/yjs/YjsPersistenceGateway.ts` | Optional-adapter wrapper around `YjsPersistence` |
| `backend/Server/YjsPersistence.ts` | Persistent Yjs state and Markdown snapshots |
| `backend/Server/FileManager.ts` | Shared-vault filesystem operations |
| `backend/auth/TokenService.ts` | Token issuance and verification |
| `backend/users/DBServices.ts` | User lookup and role management |
| `backend/users/databaseLifecycle.ts` | Explicit database creation and runtime validation |
| `backend/scripts/setupDatabase.ts` | Command-line entry point for schema creation and user seeding |
| `backend/queue/QueueManager.ts` | Creates and looks up one `DbQueue` per user id |
| `backend/queue/dbQueue.ts` | FIFO task queue that runs one async task at a time, used to serialize mutations to the same user row |

The Yjs backend used to live in a single `backend/yjsUtils.ts` file mixing room
lifecycle, persistence, sync-protocol handling, and awareness validation behind
module-level state. It was split into the single-responsibility classes above,
composed by `YjsCollaborationServer` and constructor-injected into
`ExpressServer` and `WebSocketServer` from `main.ts`, matching how the plugin
composes its own services.

`SyncMessageHandler.ts` was originally a class with a single `handle()`
method; it is now a plain function (`syncMessageHandler`) taking a params
object, since it held no state of its own between calls.

`ExpressServer.ts` used to register every route handler directly, mixing
Express app setup with three unrelated domains' worth of authorization logic
in one file. Routes were split by domain into `RouteAuth`, `RouteUsers`, and
`RouteSyncFiles` (`backend/Server/ExpressServer/routes/`), each owning its
own `requireAuth`/`requireAdmin` middleware and building an `express.Router`
that `ExpressServer` mounts at the matching `/api/*` prefix. Every route path
inside a router is relative to that prefix (e.g. `RouteUsers` registers
`/:id/name`, not `/api/users/:id/name`) — a router mounted with a path
already registered under its own full path would double the prefix.

`ExpressServer` is also constructor-injected with a `QueueManager`. Every
route that mutates a user's row (`POST /api/users`,
`PATCH /api/users/:id/name`, `PATCH /api/users/:id/password`,
`PATCH /api/users/:id/role`, `PATCH /api/users/:id/status`,
`DELETE /api/users/:id`) enqueues its work on that user's `DbQueue` instead
of running it inline, so concurrent requests targeting the same user never
race each other. `POST /api/users` queues by the submitted email since no id
exists yet. `GET /api/users` is a read and is unaffected.

## Communication channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| HTTPS `/api/auth/login` | client → server | Rate-limited login and access/refresh token issuance |
| HTTPS `/api/auth/refresh` | client ↔ server | Refresh-token rotation and short access-token renewal |
| HTTPS `/api/auth/logout` | client → server | Session revocation |
| HTTPS `/api/auth/ws-ticket` | client ← server | One-use, channel-scoped WebSocket ticket |
| HTTPS `/api/users/*`, `/api/sync/initSync` | client ↔ server | User administration and initial vault download |
| HTTPS `/api/sync/*` | admin → server | Shared file operations |
| WSS `/system` | server → client | Shared-vault change notifications |
| WSS `/<encoded-note-path>` | client ↔ server | Yjs synchronization and awareness |

The `/system` channel is receive-only from the client's perspective. WebSocket
handshakes use one-use tickets in `Sec-WebSocket-Protocol`, never bearer tokens
in URLs. The Yjs channel accepts awareness from authenticated clients, but
document updates are accepted only from admins.
