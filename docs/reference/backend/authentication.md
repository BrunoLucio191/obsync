# Backend authentication API

## TokenService

`TokenService` owns every server-side session and credential operation.

Source: [`backend/auth/TokenService.ts`](../../../backend/auth/TokenService.ts)

```ts
new TokenService({
	secret: string,
	dbService: DBServices,
})
```

The signing secret must contain at least 32 bytes. Sessions and ticket records
are kept in memory, so restarting the backend revokes all active sessions.

### `sessionFor()`

```ts
sessionFor(user: AuthenticatedUser): AuthSession
```

Creates a new session ID, 15-minute access token, and rotating refresh token.
Only the HMAC hash of the refresh token is retained on the backend.

### `verifyToken()`

```ts
verifyToken(
	token: string | null | undefined,
): Promise<AuthenticatedUser | null>
```

Validates signature, header, issuer, audience, time claims, session existence,
and user status. It reloads the current user from SQLite instead of trusting
profile data supplied by the client.

### `refreshSession()`

```ts
refreshSession(
	refreshToken: string | null | undefined,
): Promise<AuthSession | null>
```

Validates the opaque refresh token and its session, reloads the user, rotates
the refresh token, and returns a new access token. The previous refresh token
stops matching after a successful rotation.

### `revokeSession()`

```ts
revokeSession(refreshToken: string | null | undefined): void
```

Deletes the matching session, removes its unused WebSocket tickets, and calls
registered revocation listeners. Invalid input is ignored.

### `issueWebSocketTicket()`

```ts
issueWebSocketTicket(
	accessToken: string | null | undefined,
	channel: 'system' | 'yjs',
): Promise<WebSocketTicket | null>
```

Creates a random 30-second ticket after validating the access token. The record
is scoped to one channel and stores the session and access-token expiration.

### `consumeWebSocketTicket()`

```ts
consumeWebSocketTicket(
	ticket: string | null | undefined,
	channel: 'system' | 'yjs',
): Promise<WebSocketAuthorization | null>
```

Deletes the ticket before validating the remaining conditions, making every
handshake attempt one-use. Returns the current user, session ID, and access
expiration when accepted.

### `onSessionRevoked()`

```ts
onSessionRevoked(
	listener: (sessionId: string) => void,
): () => void
```

Registers a listener and returns an unsubscribe function. The WebSocket server
uses it to close every connection owned by a revoked session.

## LoginRateLimiter

Source: [`backend/auth/LoginRateLimiter.ts`](../../../backend/auth/LoginRateLimiter.ts)

```ts
new LoginRateLimiter({
	attemptWindowMs?,
	blockDurationMs?,
	maxFailedAttempts?,
	maxTrackedKeys?,
})
```

Defaults are a 15-minute attempt window, 15-minute block, five failures, and
10,000 tracked keys. `ExpressServer` uses separate instances for account and IP
limits; the IP instance allows 25 failures.

| Method | Return | Behavior |
| --- | --- | --- |
| `check(key)` | `LoginRateLimit` | Reads current permission without recording a failure |
| `recordFailure(key)` | `LoginRateLimit` | Adds a failure and starts a block at the threshold |
| `reset(key)` | `void` | Removes the key and its history |

```ts
type LoginRateLimit = {
	allowed: boolean;
	retryAfterSeconds: number;
};
```

Expired records are removed during normal operations. New keys are denied when
the configured memory bound is reached.

## Password functions

Source: [`backend/auth/PasswordUtil.ts`](../../../backend/auth/PasswordUtil.ts)

| Function | Purpose |
| --- | --- |
| `hashPassword(password)` | Creates a salted password hash for storage |
| `passwordMatches(password, storedHash)` | Compares a submitted password with a stored hash |

## Related references

- [Authentication endpoints](http.md#authentication)
- [WebSocket handshake](websocket.md#authentication-handshake)
- [Authentication objects](types.md#authentication)
