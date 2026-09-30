# HTTP API

All routes live under `/api`. Requests and responses are JSON unless an
endpoint says otherwise. Remote deployments must use HTTPS (see
[Security](../../security.md#transport-rules)); loopback development may use
HTTP.

## Common headers

| Header | When | Purpose |
| --- | --- | --- |
| `Authorization: Bearer <access token>` | Every route marked *auth* | Identifies the session. The user is reloaded from SQLite on every request |
| `X-ObSync-Client: <uuid>` | Every route marked *clientId* | Selects the queue the request runs on and becomes `originClientId` in broadcasts. Missing → `400` |
| `X-ObSync-Gene: <gene json>` | `POST /api/sync/initSync` | The gene the client saved after its last complete download |

Errors use `{ "error": "Human-readable message" }`. Failed user mutations also
include a machine-readable `reason`:

```json
{ "error": "this operation would leave the platform without an active administrator.", "reason": "LAST_ADMIN" }
```

Responses under `/api/auth` carry `Cache-Control: no-store`.

## Authentication

### `POST /api/auth/login`

```json
{ "email": "admin@example.com", "password": "..." }
```

Returns an `AuthSession`:

```json
{
  "token": "<access token>",
  "refreshToken": "<session id>.<random>",
  "expiresIn": 900,
  "user": { "id": 1, "email": "admin@example.com", "name": "Admin", "role": "admin", "active": true, "color": "#3498db" }
}
```

`400` for malformed input, `401` for wrong credentials, `429` with
`Retry-After` when the account (5) or IP (25) limit within 15 minutes is
reached.

### `POST /api/auth/refresh`

```json
{ "refreshToken": "<refresh token>" }
```

Returns a new `AuthSession` with a new refresh token; the old one stops
working. `401` for an unknown, expired or already rotated token.

### `POST /api/auth/logout`

```json
{ "refreshToken": "<refresh token>" }
```

Revokes the session (closing its WebSockets) and returns `204`, also for
unknown input.

### `GET /api/auth/me`

*auth*. Returns `{ "user": AuthenticatedUser }` from the database.

### `POST /api/auth/ws-ticket`

*auth*.

```json
{ "channel": "yjs" }
```

`channel` is `system` or `yjs`; anything else returns `400`. Returns:

```json
{ "ticket": "<43 base64url characters>", "expiresIn": 30 }
```

### `POST /api/auth/change-password`

*auth, clientId*. Changes the caller's own password, for either role.

```json
{ "currentPassword": "old", "newPassword": "new password" }
```

`newPassword` must have 6 to 128 characters (`400`). A wrong current password
returns `401` with `reason: "INVALID_CURRENT_PASSWORD"`; five wrong attempts in
15 minutes return `429`. Success: `200 { user }`.

### `PATCH /api/auth/color`

*auth, clientId*. Changes the caller's cursor color.

```json
{ "color": "#9b59b6" }
```

The value must be `#rrggbb` (`400` otherwise); it is stored lowercase.
Success: `200 { user }`. Live connections are not closed.

## User administration

*auth, admin*, and *clientId* on every route except `GET /api/users`.

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/users` | none | `200 { users: AuthenticatedUser[] }` |
| `POST /api/users` | `{ name, email, password, role? }` | `201 { user }` |
| `PATCH /api/users/:id/name` | `{ name }` | `200 { user }` |
| `PATCH /api/users/:id/password` | `{ newPassword }` | `200 { user }` |
| `PATCH /api/users/:id/role` | `{ role }` | `200 { user }` |
| `PATCH /api/users/:id/status` | `{ active }` | `200 { user }` |
| `DELETE /api/users/:id` | none | `200 { user }` (the deleted user) |

Validation and rules:

- Names have 2 to 64 characters; passwords 6 to 128; e-mails must look like
  `a@b.c`. A missing or invalid `role` on creation defaults to `user`.
- Duplicate e-mail or name on creation: `409` with `reason` `email_exists` or
  `name_exists`. Duplicate name on rename: `409`, `NAME_EXISTS`.
- An admin can rename another admin only if it is themselves (`403`).
- `/:id/password` only accepts a `user` target (`403` otherwise). Admins change
  their own password with `POST /api/auth/change-password`.
- Any change that would leave no active admin returns `409`, `LAST_ADMIN`.
- Unknown user: `404`, `NOT_FOUND`.

Name, role, status and delete close the target user's WebSockets so they
reconnect with the new permissions.

## Vault synchronization

### `POST /api/sync/initSync`

*auth, clientId*, any role. The body is ignored.

- If `X-ObSync-Gene` equals the current gene: `204 No Content`.
- Otherwise: `200` with the vault as a ZIP attachment and the current gene in
  the `X-ObSync-Gene` response header. Hidden files are excluded. The ZIP is
  deleted from `data/zips/` 15 seconds later.

### `GET /api/sync/getFile?path=<path>&fileName=<name>`

*auth, clientId*, any role. Sends one file from the vault as an attachment.
`404` if it is not an existing file (it was renamed or deleted after the event
that announced it).

### `POST /api/sync/create`

*auth, admin, clientId*.

```json
{ "path": "Projects/plan.md", "isFolder": false, "content": "# Plan" }
```

Creates a folder, or a text file with `content`. If the path had been deleted
earlier, its old Yjs state is removed first. Broadcasts a `create` event.
`path` is passed through `decodeURI`.

### `POST /api/sync/createFile`

*auth, admin, clientId*. Creates or replaces a binary file.

```http
Content-Type: application/octet-stream
X-ObSync-filePath: Assets/diagram.png

<raw bytes, up to 600 MB>
```

`400` if the header is missing or the body is empty. Broadcasts a `create`
event with `isBinary: true` and no content; clients download it with
`getFile`.

### `PUT /api/sync/modify`

*auth, admin, clientId*.

```json
{ "path": "Projects/plan.md", "content": "# Plan v2" }
```

Overwrites the file and broadcasts a `modify` event. `409` if the path is
marked deleted. Does not update the note's Yjs state (see
[Known issues](../../known-issues.md#put-apisyncmodify-does-not-update-yjs-state)).

### `DELETE /api/sync/delete`

*auth, admin, clientId*.

```json
{ "path": "Projects", "isFolder": true }
```

Marks the path deleted (closing live rooms under it), deletes it recursively,
removes its Yjs state, and broadcasts a `delete` event.

### `PUT /api/sync/rename`

*auth, admin, clientId*.

```json
{ "oldPath": "Projects/plan.md", "newPath": "Archive/plan.md" }
```

Moves the Yjs state and the file, then broadcasts a `rename` event with
`isFolder`. `200` without a broadcast if only the destination exists
(already moved with its parent folder); `404` if neither exists.

## Status summary

| Status | Meaning |
| --- | --- |
| `200` | Success |
| `201` | User created |
| `204` | Logout done, or initial sync not needed |
| `400` | Invalid input or missing `X-ObSync-Client` |
| `401` | Missing, expired or invalid session; wrong current password |
| `403` | Not allowed for this role or target |
| `404` | User, file or rename source not found |
| `409` | Last admin, duplicate identity, or path marked deleted |
| `426` | HTTPS required by the deployment configuration |
| `429` | Rate limit reached (`Retry-After` included) |
| `500` | Filesystem or unexpected server failure |
