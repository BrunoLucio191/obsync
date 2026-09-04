# HTTP API

The API accepts and returns JSON unless an endpoint is documented as a file
download. Authentication routes set `Cache-Control: no-store`.

Remote deployments must use HTTPS. Loopback development may use HTTP.

## Authorization

Protected routes require:

```http
Authorization: Bearer <access-token>
```

The server validates the access token and reloads the user from SQLite for each
request. Admin routes then check the current database role.

Error responses generally use:

```json
{ "error": "Human-readable message" }
```

## Health

### `GET /api/serverHealth`

No authentication required.

```json
{ "status": "ok", "service": "obsync" }
```

## Authentication

### `POST /api/auth/login`

```json
{
  "email": "admin@example.com",
  "password": "password"
}
```

Returns `AuthSession` on success. Account and IP failure limits can return
`429` with a `Retry-After` header. Invalid credentials return `401`.

### `POST /api/auth/refresh`

```json
{ "refreshToken": "<opaque-refresh-token>" }
```

Returns a new `AuthSession` and rotates the refresh token. An invalid, expired,
or already-rotated value returns `401`.

### `POST /api/auth/logout`

```json
{ "refreshToken": "<opaque-refresh-token>" }
```

Revokes the matching session and returns `204`. The operation is idempotent for
unknown input.

### `GET /api/auth/me`

Requires authentication. Returns the current database profile:

```json
{ "user": { "id": 1, "email": "...", "name": "...", "role": "admin", "active": true } }
```

### `POST /api/auth/change-password`

Requires authentication. Any role can change its own password; there is no
admin-triggered reset for another account.

```json
{ "currentPassword": "old-password", "newPassword": "new-password" }
```

`newPassword` must contain 6–128 characters. `currentPassword` is verified
against the stored hash before the update. Failed attempts are rate-limited
per account (5 per 15 minutes, independent of the login limiter) and return
`429` with `Retry-After` once exceeded. An incorrect current password returns
`401`. Returns `200 { user }` on success.

### `POST /api/auth/ws-ticket`

Requires authentication.

```json
{ "channel": "system" }
```

`channel` must be `system` or `yjs`. Returns:

```json
{ "ticket": "<one-use-ticket>", "expiresIn": 30 }
```

## User administration

All routes in this section require an active admin.

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/users` | none | `200 { users: AuthenticatedUser[] }` |
| `POST /api/users` | `name`, `email`, `password`, optional `role` | `201 { user }` |
| `PATCH /api/users/:id/name` | `{ name }` | `200 { user }` |
| `PATCH /api/users/:id/password` | `{ newPassword }` | `200 { user }` |
| `PATCH /api/users/:id/role` | `{ role }` | `200 { user }` |
| `PATCH /api/users/:id/status` | `{ active }` | `200 { user }` |
| `DELETE /api/users/:id` | none | `200 { user }` |

Names contain 2–64 characters. Passwords contain 6–128 characters. The backend
prevents operations that would leave no active admin; an admin may otherwise
deactivate or delete their own account. An admin may change only their own
name when the target is another admin. `PATCH /api/users/:id/password` only
accepts a `user`-role target — an admin resets their own password through
[`POST /api/auth/change-password`](#post-apiauthchange-password) instead, which
requires the current password.

Every route above except `GET /api/users` runs its work on a per-target-user
`DbQueue` (see [QueueManager](services.md#queuemanager)) instead of inline,
so two concurrent mutations of the same user are serialized rather than
racing. `POST /api/users` has no id yet, so it queues by the submitted email
instead.

## Initial vault download

### `POST /api/sync/initSync`

Requires authentication for either role. Returns the shared vault as
`vault.zip`. The temporary ZIP is removed after the response completes.

## Shared-vault sync

Every `/api/sync/*` endpoint requires an active admin.

### `POST /api/sync/create`

```json
{
  "path": "Folder/note.md",
  "isFolder": false,
  "content": "Initial text"
}
```

Creates a file or folder and publishes a `VaultChange` event.

### `PUT /api/sync/modify`

```json
{ "path": "Folder/note.md", "content": "Updated text" }
```

Writes a non-deleted file and publishes a modify event.

### `DELETE /api/sync/delete`

```json
{ "path": "Folder/note.md", "isFolder": false }
```

Marks the path deleted, removes Markdown and Yjs state, and publishes a delete
event.

### `PUT /api/sync/rename`

```json
{
  "oldPath": "Folder/old.md",
  "newPath": "Folder/new.md"
}
```

Moves the Markdown path and its persisted Yjs state, then publishes a rename
event.

The plugin sends `X-ObSync-Client` on authenticated requests. Its value is
copied to `originClientId` so the originating client can ignore the broadcast.

## Status summary

| Status | Typical meaning |
| --- | --- |
| `200` | Successful read or mutation |
| `201` | User created |
| `204` | Logout completed |
| `400` | Invalid request data |
| `401` | Missing, expired, or invalid session |
| `403` | Authenticated user lacks permission |
| `404` | Target user not found |
| `409` | Domain conflict such as last admin or duplicate identity |
| `426` | HTTPS required by deployment configuration |
| `429` | Login rate limit reached |
| `500` | Filesystem or server failure |
