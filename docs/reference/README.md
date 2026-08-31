# API reference

The reference documents ObSync's internal application API. It is intended for
contributors and is not a versioned SDK contract. A method marked public is
callable by another project module; authorization rules still belong to the
backend.

## Plugin

| Reference | Main symbols |
| --- | --- |
| [Plugin API index](plugin/README.md) | Composition and lifecycle map |
| [ObSync](plugin/ObSync.md) | Plugin lifecycle and settings-facing commands |
| [Authentication](plugin/authentication.md) | `AuthService`, `UserAdminService` |
| [Collaboration](plugin/collaboration.md) | `CollaborationController`, room functions |
| [Synchronization](plugin/synchronization.md) | File sync, system events, muted paths |
| [Data types](plugin/types.md) | Sessions, users, rooms, and vault changes |

## Backend

| Reference | Main symbols |
| --- | --- |
| [Backend API index](backend/README.md) | Composition and service map |
| [Authentication](backend/authentication.md) | `TokenService`, `LoginRateLimiter` |
| [Services](backend/services.md) | Database, filesystem, Yjs, HTTP, WebSocket, and per-user queue services |
| [HTTP API](backend/http.md) | Routes, request bodies, responses, and authorization |
| [WebSocket API](backend/websocket.md) | Ticket handshake, channels, close codes, and messages |
| [Data types](backend/types.md) | Backend authentication and mutation objects |

## Reference page format

Class pages use a consistent order:

1. purpose and source location;
2. constructor and dependencies;
3. public properties;
4. public methods with parameters and return values;
5. lifecycle or security behavior;
6. a short usage example when it clarifies the contract.

Private methods are described only when they explain an important lifecycle or
security invariant. Their signatures are not treated as stable APIs.
