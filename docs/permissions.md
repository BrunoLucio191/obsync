# Authorization model

Authorization in ObSync is a single role check (`admin` or `user`) applied at
every entry point that can change shared state. The plugin applies the same
rules to avoid sending requests that would fail, but only the backend's checks
count: they use the role reloaded from SQLite, never a value sent by the
client.

## Capabilities

| Capability | `admin` | `user` |
| --- | :---: | :---: |
| Edit notes locally | Yes | Yes |
| Keep local Yjs history (IndexedDB) | Yes | Yes |
| Receive shared changes (initial download, `/system`, Yjs) | Yes | Yes |
| Publish Yjs edits to a shared note | Yes | No |
| Create, modify, rename or delete shared files | Yes | No |
| Manage accounts (create, rename, role, status, delete, reset a user's password) | Yes | No |
| Change own password and cursor color | Yes | Yes |

## Where the backend enforces it

### HTTP

Each route declares its middleware chain in the router:

```ts
// backend/Server/ExpressServer/routes/route.syncFiles.ts
this.router.delete(
  "/delete",
  this.#authMiddleware,      // valid session, user reloaded from SQLite
  this.#adminMiddleware,     // role === "admin", otherwise 403 + audit log
  this.#clientIdMiddleware,  // X-ObSync-Client header present
  this.#syncFilesController.delete,
);
```

| Route group | Middleware |
| --- | --- |
| `/api/auth/login`, `/refresh`, `/logout` | none (they create or end a session) |
| `/api/auth/me`, `/ws-ticket` | auth |
| `/api/auth/change-password`, `/color` | auth, clientId |
| `GET /api/users` | auth, admin |
| other `/api/users/*` | auth, admin, clientId |
| `/api/sync/initSync`, `/getFile` | auth, clientId (any role can download) |
| other `/api/sync/*` | auth, admin, clientId |

A refused admin-only request is logged as
`[ExpressServer] Global operation blocked` with the user id, role, method,
route and target path.

Controllers add rules the role alone cannot express:

- `UsersController.renameUser`: an admin can rename another admin only if it is
  themselves.
- `UsersController.changePassword`: the target must be a `user`.
- `DBServices`: no operation may leave the system without an active admin
  (demoting, deactivating or deleting the last one returns `LAST_ADMIN`, HTTP
  `409`).

### Yjs

`canWriteGlobal` is computed once per connection from the role reloaded during
the ticket check:

```ts
// backend/yjs/YjsCollaborationServer.ts
canWriteGlobal: authenticatedUser.userRole === "admin",
```

`syncMessageHandler` drops `SyncStep2` and `Update` messages from connections
without it, before they touch the shared document:

```ts
if (!connectionState.canWriteGlobal) {
  console.warn("[Audit] Global Yjs update blocked", { userId, role, operation, path, ... });
  return;
}
Y.applyUpdate(room.doc, update, connection);
```

Awareness (presence) is accepted from both roles, subject to the ownership
checks in [Collaboration](collaboration.md#awareness-ownership-awarenessownershipguardts).

### `/system`

The `/system` channel is receive-only for every role: any message from a
client is logged and the socket is closed with `1008`.

### When a role changes

Changing a user's role, status or name, or deleting the user, emits
`authorization-changed`. `WebSocketServer` closes that user's sockets with
`4003`. The plugin reconnects with a new ticket, and the new connection gets
the new `canWriteGlobal`. HTTP requests pick up the new role immediately,
because every request reloads the user.

## Where the plugin applies it

These checks prevent pointless requests and keep regular users' edits local.
They are not a security boundary.

- `SyncVaultChanges.#shouldPublish()` publishes only when `auth.isAdmin()`, and
  checks again right before sending (`#canSendRequest()`), after a possible
  token refresh.
- `collab.ts` gives a regular user's provider a separate `networkDoc` that
  never receives local edits.
- `RemoteVaultChangeService` and `ZipWorkerSon` route a regular user's incoming
  files through `ServerVersionMerger` instead of overwriting.
- The settings tab shows user management only to admins.

## Rule for new code

Authorization decisions must use `res.locals.authenticatedUser` (HTTP) or
`YjsConnectionState` (Yjs), both built from the database. Never read a role,
user id or permission from the request body, a header, or awareness state.

## Related reference

- [HTTP API](reference/backend/http.md)
- [Backend authentication services](reference/backend/authentication.md)
- [Plugin authentication API](reference/plugin/authentication.md)
