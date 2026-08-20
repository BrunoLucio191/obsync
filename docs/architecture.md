# Architecture

## Plugin modules

| Module | Responsibility |
| --- | --- |
| `plugin/obSync/src/main.ts` | Plugin lifecycle, authentication, Obsidian events, system channel, and room selection |
| `plugin/obSync/src/collab/collab.ts` | Yjs documents, WebSocket provider, awareness, reconnection, and role-specific document ownership |
| `plugin/obSync/src/offlinePersistence.ts` | IndexedDB database naming, loading, and lifecycle |
| `plugin/obSync/src/sync/SyncInitialVault.ts` | Initial shared-vault download |
| `plugin/obSync/src/sync/SyncVaultChanges.ts` | Admin-only file create, modify, delete, and rename requests |
| `plugin/obSync/src/settings.ts` | Authentication settings and user administration UI |

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

## Communication channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| HTTP `/auth/*` | client ↔ server | Login and session validation |
| HTTP `/api/*` | client ↔ server | User administration and initial vault download |
| HTTP `/sync/*` | admin → server | Shared file operations |
| WebSocket `/system` | server → client | Shared-vault change notifications |
| WebSocket `/<encoded-note-path>` | client ↔ server | Yjs synchronization and awareness |

The `/system` channel is receive-only from the client's perspective. The Yjs channel accepts awareness from authenticated clients, but document updates are accepted only from admins.

