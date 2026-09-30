# Plugin API

The plugin is composed in `ObSync` (`src/main.ts`), which creates the services
and connects them through constructor dependencies.

```text
ObSync
├── AuthService ── UserAdminService
├── PathMuteRegistry
├── CollaborationController ── collab.ts room functions ── OfflinePersistence
├── QueueManager(KeyedLock)
├── ServerVersionMerger ── SyncBaseStore
├── RemoteVaultChangeService
├── SystemChannel
├── SyncInitialVault ── Boss ── ZipWorkerSon ── zip.worker (Web Worker)
├── SyncVaultChanges
└── ObSyncSettingTab ── SettingsController (implemented by ObSync)
    ├── BackendConnectionSection
    ├── AccountSettingsSection
    └── UserManagementSection
        ├── UserDirectory
        ├── UserListSection
        ├── UserNameEditor
        └── CreateUserSection
```

## Classes and modules

| Symbol | Responsibility | Reference |
| --- | --- | --- |
| `ObSync` | Composition, lifecycle, settings commands | [ObSync](ObSync.md) |
| `AuthService` | Credentials, session, role checks, headers, tickets | [Authentication](authentication.md#authservice) |
| `UserAdminService` | User-management HTTP client | [Authentication](authentication.md#useradminservice) |
| `CollaborationController` | Room for the active Markdown note | [Collaboration](collaboration.md#collaborationcontroller) |
| `setupCollabRoom()` | Builds a Yjs room | [Collaboration](collaboration.md#setupcollabroom) |
| `SyncInitialVault`, `Boss`, `ZipWorkerSon` | Initial download | [Synchronization](synchronization.md#initial-download) |
| `SyncVaultChanges` | Publishes an admin's vault events | [Synchronization](synchronization.md#syncvaultchanges) |
| `SystemChannel` | `/system` WebSocket | [Synchronization](synchronization.md#systemchannel) |
| `RemoteVaultChangeService` | Applies remote vault events | [Synchronization](synchronization.md#remotevaultchangeservice) |
| `ServerVersionMerger`, `SyncBaseStore` | Three-way merge for regular users | [Synchronization](synchronization.md#serverversionmerger) |
| `PathMuteRegistry` | Feedback-loop suppression | [Synchronization](synchronization.md#pathmuteregistry) |
| `Queue`, `QueueManager`, `KeyedLock` | Operation ordering (same as backend) | [Backend services](../backend/services.md#queue-queuemanager-and-keyedlock) |
| Settings sections | Settings tab | [Settings](settings.md) |
| `initI18n()`, `t()`, `localizeBackendError()` | Localized UI text | [Internationalization](i18n.md) |

## Runtime backend endpoint

Source: [`plugin/obSync/src/config/ApiConfig.ts`](../../../plugin/obSync/src/config/ApiConfig.ts)

The backend URL is chosen at runtime in the settings, so one plugin build works
with any backend. It is held in a module-level variable.

| Function | Purpose |
| --- | --- |
| `isApiEndpointConfigured()` | Whether a URL is set |
| `configureApiEndpoint(rawUrl)` | Validates and stores it; throws a localized `Error` on failure |
| `clearApiEndpoint()` | Back to the unconfigured state |
| `getApiBaseUrl()` | HTTP base URL; throws if none is configured |
| `getWebSocketBaseUrl()` | Same URL with `ws`/`wss` |
| `webSocketTicketProtocol(ticket)` | `obsync-ticket.<ticket>` |

Only `http:` and `https:` are accepted, and `http:` only for `127.0.0.1`,
`::1` and `localhost`. A trailing slash is removed.

## Data objects

See [Plugin data types](types.md).

## Source root

[`plugin/obSync/src`](../../../plugin/obSync/src/)
