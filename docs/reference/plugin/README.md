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
└── ObiSyncSettingTab ── SettingsController
```

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

## Main data objects

See [Plugin data types](types.md) for `AuthenticatedUser`, `AuthSession`,
`UserActionResult`, `ActiveRoom`, `PreparedCollabRoom`, and `VaultChange`.

## Source root

Plugin source lives in [`plugin/obSync/src`](../../../plugin/obSync/src/).
