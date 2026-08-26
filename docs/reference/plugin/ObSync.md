# ObSync

`ObSync` is the plugin entry point and composition root. It extends Obsidian's
`Plugin`, owns the service instances, and exposes the commands required by the
settings UI.

Source: [`plugin/obSync/src/main.ts`](../../../plugin/obSync/src/main.ts)

```ts
export default class ObSync extends Plugin
```

## Public property

### `config`

```ts
config: ObSyncConfig
```

Contains non-secret session metadata. Tokens are owned by `AuthService` and
stored through Obsidian `SecretStorage`.

## Lifecycle methods

### `onload()`

```ts
onload(): Promise<void>
```

Initializes i18next against Obsidian's configured language, loads
configuration, applies the stored `backendUrl` (if any) through
[`ApiConfig`](README.md#runtime-backend-endpoint), constructs services,
registers the settings tab, and waits for `workspace.onLayoutReady()` before
starting authentication and sync. A stored URL that fails to apply is logged
and skipped rather than blocking the rest of `onload()`, since a broken saved
value should never keep the whole plugin from loading.

### `onunload()`

```ts
onunload(): void
```

Disconnects WebSockets and collaboration rooms, clears timers, and releases
the muted-path registry.

## Session methods

### `openLogin()`

```ts
openLogin(): Promise<boolean>
```

Restores an existing session or opens the login modal. On success, starts the
sync services if they have not been started yet. Returns `true` only when the
plugin has an authenticated session and synchronization can continue.

### `logout()`

```ts
logout(): Promise<void>
```

Revokes the current backend session, clears local credentials, refreshes the
settings UI, and prompts for a new login.

### `isAuthenticated()`

```ts
isAuthenticated(): boolean
```

Returns whether `AuthService` currently has both credentials and a user
profile. It does not replace backend validation before a protected request.

## User-management methods

These methods delegate to `UserAdminService` and return a discriminated
`UserActionResult<T>`.

| Method | Parameters | Result |
| --- | --- | --- |
| `listUsers()` | none | `AuthenticatedUser[]` |
| `createUser(input)` | `name`, `email`, `password`, `role` | created user |
| `updateUserRole(userId, role)` | numeric ID and `admin` or `user` | updated user |
| `updateUserStatus(userId, active)` | numeric ID and active flag | updated user |
| `updateUserName(userId, name)` | numeric ID and display name | updated user |
| `deleteUser(userId)` | numeric ID | deleted user snapshot |
| `resetUserPassword(userId, newPassword)` | numeric ID and new password | updated user |

```ts
const result = await plugin.updateUserRole(12, 'admin');
if (!result.ok) {
	new Notice(result.error);
}
```

The backend remains the authority for every user-management operation.
`resetUserPassword` is admin-only and, unlike `changePassword` below, does not
require the target account's current password. See
[Settings: user management](settings.md#usermanagementsection) for the UI
that calls it and the restrictions the settings layer adds on top (an admin
can never reset another admin's password).

## Account methods

### `changePassword()`

```ts
changePassword(
	currentPassword: string,
	newPassword: string,
): Promise<UserActionResult<null>>
```

Delegates to `AuthService`. Lets the signed-in account change its own
password. Unlike `resetUserPassword`, this always requires the caller's
current password, whether they're an admin or a regular user.

### `setBackendUrl()`

```ts
setBackendUrl(url: string): Promise<UserActionResult<null>>
```

Validates `url` through
[`configureApiEndpoint()`](README.md#runtime-backend-endpoint), persists it
to `config.backendUrl` on success, and returns the validation error as
`UserActionResult` failure otherwise so the settings UI can show it inline
instead of throwing. An empty string is valid input and clears the
configured endpoint, returning the plugin to its pre-setup state. If the URL
actually changes while a session is already connected, the previous session
is cleared first, since its tokens belong to a different backend and sending
them anywhere else would be wrong. See
[Settings: BackendConnectionSection](settings.md#backendconnectionsection)
for the field that calls this and who is allowed to edit it.
