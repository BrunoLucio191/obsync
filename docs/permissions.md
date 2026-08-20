# Authorization model

| Capability | `admin` | `user` |
| --- | :---: | :---: |
| Edit the local note | Yes | Yes |
| Persist local Yjs history | Yes | Yes |
| Receive shared note updates | Yes | Yes |
| Publish Yjs document updates | Yes | No |
| Create, modify, rename, or delete shared files | Yes | No |
| Manage user accounts and roles | Yes | No |

## Plugin enforcement

`SyncVaultChanges` checks the current role before calling any `/sync` endpoint:

```ts
if (!this.auth.isAdmin() || this.mutedPaths.isMuted(file.path)) return;
```

User sessions also keep the private editor document separate from the document passed to `WebsocketProvider`.

## HTTP enforcement

All shared-vault mutation routes require both authentication and the admin role:

```ts
this.app.use('/sync', requireAuth, requireAdmin);
```

## Yjs enforcement

The WebSocket connection records write permission from the authenticated database user:

```ts
canWriteGlobal: authenticatedUser.userRole === 'admin';
```

Document updates from read-only connections are discarded before they reach the shared document:

```ts
if (!connectionState.canWriteGlobal) {
	return;
}
```

Authorization decisions must use the backend's authenticated user record. Values sent by the client are not trusted for access control.

## Related reference

- [Plugin authentication API](reference/plugin/authentication.md)
- [Backend authentication services](reference/backend/authentication.md)
- [HTTP authorization](reference/backend/http.md#authorization)
