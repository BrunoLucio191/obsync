# Architecture

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
│   ├── ApiConfig.ts                backend endpoint configuration
│   └── ObiSyncConfig.ts            persisted plugin configuration
├── settings/
│   ├── ObiSyncSettingTab.ts        settings composition
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
| `plugin/obSync/src/settings/ObiSyncSettingTab.ts` | Composes account and user-management settings sections |
| `plugin/obSync/src/settings/users/*` | Separates the user directory, creation form, list actions, and debounced name updates |

## Dependency direction

```text
ObSync (composition root)
  ├── AuthService ── UserAdminService
  ├── CollaborationController ── Yjs/IndexedDB helpers
  ├── SystemChannel ── RemoteVaultChangeService
  ├── SyncInitialVault
  ├── SyncVaultChanges
  └── ObiSyncSettingTab ── SettingsController interface
```

Services receive their dependencies through constructors. They do not receive
the complete `ObSync` object, except where the Obsidian `Plugin` lifecycle API
is explicitly required to register vault events. The settings sections depend
on `SettingsController`, so their code is not coupled to the concrete plugin
entry class.

Low-level Yjs protocol helpers remain functions. They are stateless operations,
so wrapping each one in a class would add indirection without creating a useful
object boundary.

## Backend modules

| Module | Responsibility |
| --- | --- |
| `backend/server.ts` | Application composition and startup |
| `backend/Classes/ExpressServer.ts` | HTTP routes and route-level authorization |
| `backend/Classes/WebSocketServer.ts` | WebSocket upgrade authentication and channel routing |
| `backend/yjsUtils.ts` | Yjs protocol handling, shared rooms, awareness, and update authorization |
| `backend/Classes/YjsPersistence.ts` | Persistent Yjs state and Markdown snapshots |
| `backend/Classes/FileManager.ts` | Shared-vault filesystem operations |
| `backend/auth/TokenService.ts` | Token issuance and verification |
| `backend/users/DBServices.ts` | User lookup and role management |
| `backend/users/databaseLifecycle.ts` | Explicit database creation and runtime validation |
| `backend/scripts/setupDatabase.ts` | Command-line entry point for schema creation and user seeding |

## Communication channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| HTTP `/auth/*` | client ↔ server | Login and session validation |
| HTTP `/api/*` | client ↔ server | User administration and initial vault download |
| HTTP `/sync/*` | admin → server | Shared file operations |
| WebSocket `/system` | server → client | Shared-vault change notifications |
| WebSocket `/<encoded-note-path>` | client ↔ server | Yjs synchronization and awareness |

The `/system` channel is receive-only from the client's perspective. The Yjs channel accepts awareness from authenticated clients, but document updates are accepted only from admins.
