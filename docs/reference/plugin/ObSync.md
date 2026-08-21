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

Loads configuration, constructs services, registers the settings tab, and
waits for `workspace.onLayoutReady()` before starting authentication and sync.

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

```ts
const result = await plugin.updateUserRole(12, 'admin');
if (!result.ok) {
	new Notice(result.error);
}
```

The backend remains the authority for every user-management operation.
