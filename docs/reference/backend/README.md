# Backend API

The backend composes its services in `server.ts`. HTTP and WebSocket transports
share `TokenService`, `DBServices`, filesystem storage, and authorization rules.

```text
server.ts
├── loadServerConfig()
├── openUserDatabase()
├── DBServices
├── TokenService ── AuthService
├── FileManager ── ExpressServer
└── WebSHocket ── YjsPersistence
```

## Services

| Symbol | Responsibility | Reference |
| --- | --- | --- |
| `TokenService` | Access tokens, refresh sessions, revocation, and WS tickets | [Authentication](authentication.md#tokenservice) |
| `LoginRateLimiter` | In-memory failure windows and blocking | [Authentication](authentication.md#loginratelimiter) |
| `DBServices` | User queries and protected mutations | [Services](services.md#dbservices) |
| `ExpressServer` | Middleware, HTTP routes, and route authorization | [Services](services.md#expressserver) |
| `WebSHocket` | Upgrade authentication and channel routing | [Services](services.md#webshocket) |
| `FileManager` | Shared-vault filesystem operations | [Services](services.md#filemanager) |
| `YjsPersistence` | Binary Yjs state and Markdown snapshots | [Services](services.md#yjspersistence) |

## Protocol contracts

- [HTTP API](http.md)
- [WebSocket API](websocket.md)
- [Backend data types](types.md)

## Source root

Backend source lives in [`backend`](../../../backend/).
