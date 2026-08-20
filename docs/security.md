# Security

## Session model

Login creates two credentials:

- a 15-minute access token used in the HTTP `Authorization` header;
- a rotating refresh token valid for the current backend process.

Refresh tokens are stored as HMAC hashes in backend memory. Explicit logout
revokes the session and closes its active WebSocket connections. Restarting the
backend revokes every existing session, so clients must sign in again.

The access token contains issuer, audience, subject, session, token ID,
not-before, issued-at, and expiration claims. Every authenticated HTTP request
also resolves the current user from SQLite, so a role or status copied into an
old client cannot override the backend record.

## Client credential storage

Access and refresh tokens are stored through Obsidian's `SecretStorage`. The
persisted plugin `data.json` contains only the current user profile and the
access-token expiration time.

## WebSocket authentication

Bearer tokens are never added to WebSocket URLs. Before each connection, the
plugin requests a random, channel-scoped ticket over authenticated HTTP. The
ticket:

- expires after 30 seconds;
- is accepted only for `system` or `yjs`, as requested;
- is consumed after one handshake attempt;
- is sent through `Sec-WebSocket-Protocol` rather than the URL;
- cannot be used as an HTTP access token.

Yjs reconnection obtains a new ticket before every new socket. WebSocket
connections close when their access token expires, when the user authorization
changes, or when the session is revoked.

## Transport rules

Local development defaults to `127.0.0.1`. Plain HTTP and WebSocket are allowed
only for loopback hosts.

For a remote deployment, terminate TLS in a reverse proxy and use the following
backend configuration:

```dotenv
OBISYNC_HOST=127.0.0.1
OBISYNC_REQUIRE_TLS=true
OBISYNC_TRUST_PROXY=true
```

Keep port `3000` inaccessible from the public network. The reverse proxy must
forward `X-Forwarded-Proto: https`, including WebSocket upgrade requests.

Build the plugin with the public HTTPS endpoint:

```bash
OBISYNC_API_BASE_URL=https://sync.example.com \
  npm run build --workspace=obSync
```

The plugin refuses a non-loopback endpoint that does not use HTTPS. Its
WebSocket URL is derived automatically as WSS.

## Login rate limit

The backend tracks normalized accounts and source IPs independently. An account
is blocked after five failures in 15 minutes, while an IP is blocked after 25
failures in the same period. This limits both targeted guessing and password
spraying across multiple accounts. A block lasts 15 minutes and returns HTTP
`429` with `Retry-After`. A successful login resets the account counter; it does
not erase other failures made by that IP.

## Signing secret

`OBISYNC_TOKEN_SECRET` must contain at least 32 random bytes. Generate one
instead of writing a memorable value:

```bash
openssl rand -base64 48
```

Store it only in `backend/.env` or the deployment secret manager. Changing the
secret invalidates every access token.

## Related reference

- [AuthService](reference/plugin/authentication.md#authservice)
- [TokenService](reference/backend/authentication.md#tokenservice)
- [HTTP authentication endpoints](reference/backend/http.md#authentication)
- [WebSocket authentication handshake](reference/backend/websocket.md#authentication-handshake)
