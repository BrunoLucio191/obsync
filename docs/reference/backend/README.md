# Backend API

The backend composes its services in `server.ts`. HTTP and WebSocket transports
share `TokenService`, `DBServices`, filesystem storage, and authorization rules.

```text
server.ts
├── loadServerConfig()
├── openUserDatabase()
├── DBServices
├── TokenService ── AuthService
├── YjsCollaborationServer
├── FileManager ── ExpressServer
└── WebSocketServer ── YjsPersistence
```

`ExpressServer` and `WebSocketServer` both receive the same
`YjsCollaborationServer` instance, so REST mutations (create, delete, rename)
and live WebSocket rooms observe the same deleted-path and room state.

## Services

| Symbol | Responsibility | Reference |
| --- | --- | --- |
| `TokenService` | Access tokens, refresh sessions, revocation, and WS tickets | [Authentication](authentication.md#tokenservice) |
| `LoginRateLimiter` | In-memory failure windows and blocking | [Authentication](authentication.md#loginratelimiter) |
| `DBServices` | User queries and protected mutations | [Services](services.md#dbservices) |
| `ExpressServer` | Middleware, HTTP routes, and route authorization | [Services](services.md#expressserver) |
| `WebSocketServer` | Upgrade authentication and channel routing | [Services](services.md#websocketserver) |
| `YjsCollaborationServer` | Yjs room lifecycle, sync, and awareness | [Services](services.md#yjscollaborationserver) |
| `FileManager` | Shared-vault filesystem operations | [Services](services.md#filemanager) |
| `YjsPersistence` | Binary Yjs state and Markdown snapshots | [Services](services.md#yjspersistence) |

## Protocol contracts

- [HTTP API](http.md)
- [WebSocket API](websocket.md)
- [Backend data types](types.md)

## Source root

Backend source lives in [`backend`](../../../backend/).
