# Backend API

The backend composes its services in `backend/main.ts`. HTTP and WebSocket
transports share the same `TokenService` and `YjsCollaborationServer`
instances, and every queue shares one `KeyedLock`.

```text
main.ts
├── loadServerConfig()
├── openUserDatabase() ── UserDB
├── DBServices
├── TokenService ── AuthService
├── FileManager
├── YjsCollaborationServer
├── KeyedLock ── QueueManager (one per consumer)
├── Gene
├── ExpressServer
│   ├── RouteAuth ── AuthController
│   ├── RouteUsers ── UsersController
│   └── RouteSyncFiles ── SyncFilesController
└── WebSocketServer ── YjsPersistence
```

## Services

| Symbol | Responsibility | Reference |
| --- | --- | --- |
| `TokenService` | Sessions, access and refresh tokens, WebSocket tickets, revocation | [Authentication](authentication.md#tokenservice) |
| `AuthService` | Password login | [Authentication](authentication.md#authservice) |
| `LoginRateLimiter` | In-memory failure windows and blocking | [Authentication](authentication.md#loginratelimiter) |
| `DBServices` | User queries and protected mutations | [Services](services.md#dbservices) |
| `ExpressServer` | Middleware and router mounting | [Services](services.md#expressserver) |
| `RouteAuth`, `RouteUsers`, `RouteSyncFiles` | Endpoint registration per domain | [Services](services.md#routers) |
| `AuthController`, `UsersController`, `SyncFilesController` | Request handling | [Services](services.md#controllers) |
| `WebSocketServer` | Upgrade authentication, channels, heartbeat | [Services](services.md#websocketserver) |
| `YjsCollaborationServer` | Collaboration rooms and shared Yjs state | [Services](services.md#yjscollaborationserver) |
| `YjsPersistence` | Binary Yjs state and Markdown files | [Services](services.md#yjspersistence) |
| `FileManager` | Vault filesystem operations | [Services](services.md#filemanager) |
| `Gene` | Vault fingerprint for the initial download | [Services](services.md#gene) |
| `Queue`, `QueueManager`, `KeyedLock` | Operation ordering | [Services](services.md#queue-queuemanager-and-keyedlock) |

## Protocol contracts

- [HTTP API](http.md)
- [WebSocket API](websocket.md)
- [Backend data types](types.md)

## Source root

Backend source lives in [`backend`](../../../backend/).
