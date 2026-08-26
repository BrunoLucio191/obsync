# Plugin API

The Obsidian plugin is composed in `ObSync`. The entry class creates focused
services and connects them through constructor dependencies.

```text
ObSync
├── AuthService ── UserAdminService
├── CollaborationController ── Yjs room functions
├── SystemChannel ── RemoteVaultChangeService
├── SyncInitialVault
├── SyncVaultChanges
└── ObSyncSettingTab ── SettingsController
    ├── BackendConnectionSection
    ├── AccountSettingsSection
    └── UserManagementSection
        ├── UserDirectory
        ├── UserListSection
        ├── UserNameEditor
        └── CreateUserSection
```

`ObSync` itself implements `SettingsController`, so `ObSyncSettingTab` and
everything beneath it talk to the plugin only through that interface.

## Classes and modules

| Symbol | Responsibility | Reference |
| --- | --- | --- |
| `ObSync` | Plugin composition, lifecycle, and settings commands | [ObSync](ObSync.md) |
| `AuthService` | Credentials, current session, role checks, and refresh | [Authentication](authentication.md#authservice) |
| `UserAdminService` | User-management HTTP client | [Authentication](authentication.md#useradminservice) |
| `CollaborationController` | Active Markdown room and editor extension lifecycle | [Collaboration](collaboration.md#collaborationcontroller) |
| `setupCollabRoom()` | Low-level Yjs room construction | [Collaboration](collaboration.md#setupcollabroom) |
| `SyncInitialVault` | Initial ZIP download | [Synchronization](synchronization.md#syncinitialvault) |
| `SyncVaultChanges` | Admin-only publication of Obsidian vault events | [Synchronization](synchronization.md#syncvaultchanges) |
| `SystemChannel` | Receive-only shared-vault event channel | [Synchronization](synchronization.md#systemchannel) |
| `RemoteVaultChangeService` | Application of remote file events | [Synchronization](synchronization.md#remotevaultchangeservice) |
| `PathMuteRegistry` | Feedback-loop suppression | [Synchronization](synchronization.md#pathmuteregistry) |
| `ObSyncSettingTab` | Settings page composition and per-state visibility | [Settings](settings.md#obsyncsettingtab) |
| `BackendConnectionSection` | Backend URL field and its role-gated editability | [Settings](settings.md#backendconnectionsection) |
| `AccountSettingsSection` | The signed-in account's own profile and password | [Settings](settings.md#accountsettingssection) |
| `UserManagementSection` | Admin-only user list and creation form | [Settings](settings.md#usermanagementsection) |
| `UserDirectory` | In-memory, sorted cache of users backing the list | [Settings](settings.md#userdirectory) |
| `UserListSection` | Renders the scrollable, searchable user list | [Settings](settings.md#userlistsection) |
| `UserNameEditor` | Debounced display-name autosave | [Settings](settings.md#usernameeditor) |
| `CreateUserSection` | The "Add user" form | [Settings](settings.md#createusersection) |
| `initI18n()` / `t()` | UI text localized to Obsidian's configured language | [Internationalization](i18n.md) |

## Runtime backend endpoint

Source: [`plugin/obSync/src/config/ApiConfig.ts`](../../../plugin/obSync/src/config/ApiConfig.ts)

Unlike a build-time constant, the backend's URL is resolved at runtime from
whatever was last saved through
[`BackendConnectionSection`](settings.md#backendconnectionsection), so the
same plugin build works against any self-hosted backend without a rebuild.

| Function | Purpose |
| --- | --- |
| `isApiEndpointConfigured()` | Whether a backend URL has been set at all |
| `configureApiEndpoint(rawUrl)` | Parses and validates `rawUrl`, throwing a localized message on failure |
| `clearApiEndpoint()` | Returns the plugin to its unconfigured, pre-setup state |
| `getApiBaseUrl()` | The current HTTP base URL, throwing if none is configured |
| `getWebSocketBaseUrl()` | The `ws:`/`wss:` equivalent of the HTTP base URL |
| `webSocketTicketProtocol(ticket)` | Builds the `obsync-ticket.<ticket>` WebSocket subprotocol string |

`configureApiEndpoint()` requires `https:` for any hostname other than
`127.0.0.1`, `::1`, or `localhost`, mirroring the backend's own
[transport rules](../../security.md#transport-rules): a plain-HTTP backend
is only ever accepted on loopback.

## Main data objects

See [Plugin data types](types.md) for `AuthenticatedUser`, `AuthSession`,
`UserActionResult`, `ActiveRoom`, `PreparedCollabRoom`, and `VaultChange`.

## Source root

Plugin source lives in [`plugin/obSync/src`](../../../plugin/obSync/src/).
