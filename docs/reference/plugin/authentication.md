# Plugin authentication API

## AuthService

`AuthService` owns the plugin's authentication state. It is the only plugin
service that reads or writes access and refresh credentials.

Source: [`plugin/obSync/src/auth/AuthService.ts`](../../../plugin/obSync/src/auth/AuthService.ts)

```ts
new AuthService({
	app,
	getConfig,
	saveConfig,
	onSessionChanged,
})
```

### Constructor dependencies

| Dependency | Type | Purpose |
| --- | --- | --- |
| `app` | `App` | Accesses Obsidian `SecretStorage` and opens the login modal |
| `getConfig` | `() => ObiSyncConfig` | Reads current non-secret session metadata |
| `saveConfig` | `() => Promise<void>` | Persists user profile and access-token expiration |
| `onSessionChanged` | callback | Notifies the composition root when identity or role changes |

### `user`

```ts
get user(): AuthenticatedUser | null
```

Returns the current user profile stored in plugin configuration.

### Role and session checks

| Method | Returns | Meaning |
| --- | --- | --- |
| `isAuthenticated()` | `boolean` | Credentials and a current user are available locally |
| `isAdmin()` | `boolean` | Current profile has the `admin` role |
| `isReadOnlyUser()` | `boolean` | Current profile has the `user` role |

These checks control client behavior. The backend repeats authorization using
the current database record.

### `ensureAuthenticated()`

```ts
ensureAuthenticated(): Promise<boolean>
```

Validates stored credentials, attempts a refresh when necessary, and opens
`LoginModal` if the session cannot be restored. Returns whether authentication
completed successfully.

### `prepareAuthenticatedRequest()`

```ts
prepareAuthenticatedRequest(): Promise<boolean>
```

Ensures the access token has more than one minute remaining. If not, rotates
the refresh token and obtains a new access token before the caller sends its
request.

Typical request pattern:

```ts
if (!(await auth.prepareAuthenticatedRequest())) return;

await requestUrl({
	url: `${API_BASE_URL}/api/users`,
	headers: auth.headers(),
});
```

### `headers()`

```ts
headers(): Record<string, string>
```

Builds JSON request headers with the bearer access token and the per-plugin
`X-ObiSync-Client` identifier.

### `createWebSocketTicket()`

```ts
createWebSocketTicket(
	channel: 'system' | 'yjs',
): Promise<string | null>
```

Requests a short-lived, one-use ticket for a specific WebSocket channel.
Returns `null` when the session cannot be refreshed or the ticket endpoint
rejects the request.

### Session maintenance

| Method | Behavior |
| --- | --- |
| `scheduleSessionRefresh()` | Debounces a current-profile refresh after an account change |
| `refreshSession()` | Reloads `/auth/me` and publishes profile changes to the plugin |
| `logout()` | Revokes the backend session and clears local credentials |
| `clearSession()` | Clears local credentials without issuing the logout request |
| `destroy()` | Cancels session and access-refresh timers |

Access and refresh credentials are stored under separate IDs in Obsidian
`SecretStorage`. They are held in memory while the plugin is loaded and are not
returned by a public property.

## UserAdminService

`UserAdminService` is the typed HTTP client for the user-management screen.

Source: [`plugin/obSync/src/auth/UserAdminService.ts`](../../../plugin/obSync/src/auth/UserAdminService.ts)

```ts
new UserAdminService(auth: AuthService)
```

| Method | Request | Success value |
| --- | --- | --- |
| `listUsers()` | `GET /api/users` | `AuthenticatedUser[]` |
| `createUser(input)` | `POST /api/users` | created `AuthenticatedUser` |
| `updateUserRole(id, role)` | `PATCH /api/users/:id/role` | updated user |
| `updateUserStatus(id, active)` | `PATCH /api/users/:id/status` | updated user |
| `updateUserName(id, name)` | `PATCH /api/users/:id/name` | updated user |
| `deleteUser(id)` | `DELETE /api/users/:id` | deleted user snapshot |

Every method resolves to `UserActionResult<T>` instead of throwing expected API
errors. Transport failures and server errors are converted to an error string
for the settings UI.

## Related references

- [Plugin authentication types](types.md#authentication)
- [Backend authentication services](../backend/authentication.md)
- [HTTP authentication endpoints](../backend/http.md#authentication)
