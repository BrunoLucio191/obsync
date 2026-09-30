# Security

ObSync has three credentials with different lifetimes, one server-side session
that anchors them, and a transport policy that refuses plaintext outside
loopback. This page explains each piece, the order in which they are checked,
and how to deploy the backend beyond your own machine.

## Credentials at a glance

| Credential | Lifetime | Stored on the server as | Used for |
| --- | --- | --- | --- |
| Refresh token | 30 days, rotated on every use | HMAC hash inside the session | Getting a new access token |
| Access token | 15 minutes | Nothing (it is signed) | `Authorization: Bearer` on HTTP requests |
| WebSocket ticket | 30 seconds, one use | HMAC hash in a ticket map | Opening exactly one WebSocket |

Every credential belongs to a **session** (`sid`), kept in
`TokenService.#sessions`, an in-memory `Map`. Logout, revocation, a deleted or
deactivated user, or a backend restart remove the session, and every
credential attached to it stops working at once.

Because sessions live only in memory, **restarting the backend signs everyone
out**. This is intentional; see [Design decisions](decisions.md).

## Session model

### Login

`POST /api/auth/login` checks rate limits, loads the active user by
normalized e-mail, and verifies the password with scrypt
(`auth/PasswordUtil.ts`, stored as `<salt>:<hash>`). On success
`TokenService.sessionFor()` creates:

- a random session id;
- a refresh token `<sessionId>.<random>`, of which only the HMAC is kept;
- an access token.

### Access token

The access token is a JWT signed with HMAC-SHA256 using
`OBSYNC_TOKEN_SECRET`. JWT (JSON Web Token) is a `header.payload.signature`
string whose payload the server can trust because only the server knows the
signing key.

```json
{ "iss": "obsync", "aud": "obsync-api", "sub": "1", "sid": "<session id>",
  "jti": "<random>", "iat": 1790000000, "nbf": 1790000000, "exp": 1790000900 }
```

`TokenService.#authorizeAccessToken()` checks, in order:

1. three parts, and a signature that matches (constant-time comparison);
2. header `alg: HS256`, `typ: JWT`; issuer, audience, time claims;
3. **the session still exists**, belongs to the same user, and has not expired;
4. **the user still exists and is active**, reloaded from SQLite.

Step 3 is what makes logout and revocation immediate even though a JWT is
normally valid until `exp`. Step 4 is why a role change applies to the next
request: the role is never read from the token.

The signature is verified before the header is parsed, and the algorithm is
fixed on the server, so the classic JWT attacks (`alg: none`, algorithm
confusion) have nothing to work with.

### Refresh

`POST /api/auth/refresh` looks up the session from the id prefix of the
refresh token, compares the HMAC in constant time, reloads the user, and
issues a new access token and a **new refresh token**. The old refresh token
stops working.

The plugin makes refresh single-flight (`AuthService.#refreshPromise`): if
several requests get `401` at once, only one refresh is sent. Without this,
the second refresh would present an already rotated token and sign the user
out. The plugin also refreshes proactively one minute before the access token
expires.

### Revocation

`TokenService.#revokeSessionId()` deletes the session, deletes its pending
tickets, and notifies listeners. `WebSocketServer` listens and closes every
socket of that session with `4003`. It also listens to
`DBEvents.onAuthorizationChanged`, emitted when an admin changes a user's
name, role or status or deletes the user, and closes that user's sockets the
same way. Reconnecting goes through a new ticket, which reloads the role.

## WebSocket tickets

The browser WebSocket API cannot set an `Authorization` header, and putting the
access token in the URL would expose it to access logs. The plugin instead
exchanges its access token for a short-lived ticket and sends the ticket in the
one header it controls, `Sec-WebSocket-Protocol`.

```text
Plugin                                        Backend
POST /api/auth/ws-ticket                      #requireAuth (validates the JWT)
  Authorization: Bearer <jwt>                 TokenService.issueWebSocketTicket()
  { "channel": "yjs" }                          32 random bytes, store HMAC → { user, session, channel, +30 s }
                          ◀──────────────     { "ticket": "Xk3f...", "expiresIn": 30 }

new WebSocket(url, ["obsync-ticket.Xk3f..."]) server.on("upgrade") → #handleUpgrade
                                                TLS check (426), channel from the path
                                                #readTicketProtocol: prefix + 43 base64url chars
                                                consumeWebSocketTicket():
                                                  delete the ticket FIRST (one use, even on failure)
                                                  channel matches, ticket and access token not expired,
                                                  session exists, user reloaded from SQLite
                                                ok: accept; fail: HTTP 401 and destroy the socket
```

Where each step lives:

| Step | Code |
| --- | --- |
| Request a ticket | `AuthService.createWebSocketTicket()` (plugin) |
| Issue | `AuthController.wsTicket` → `TokenService.issueWebSocketTicket()` |
| Send | `webSocketTicketProtocol()` in `config/ApiConfig.ts`; used by `collab.ts` and `SystemChannel.ts` |
| Consume | `WebSocketServer.#handleUpgrade()` → `TokenService.consumeWebSocketTicket()` |

Properties that follow from this design:

- A ticket is valid for one channel only: a `system` ticket cannot open a note.
- The ticket lives milliseconds in practice; the plugin opens the socket right
  after receiving it. The 30 s window is only a margin.
- A connection stays open until the **access token** bound to its ticket
  expires (a timer closes it with `4003`), not until the ticket expires.
- Every reconnect needs a new ticket. See
  [Collaboration](collaboration.md#tickets-and-reconnection) for why the Yjs
  provider's built-in reconnect is disabled.
- The `ws` library echoes the first offered subprotocol back in the handshake
  response, which browsers require. The echoed ticket is already consumed.

### Why the same HMAC key hashes tokens and signs JWTs

`#sign()` and `#hashOpaqueToken()` both use HMAC-SHA256 with
`OBSYNC_TOKEN_SECRET`. The opaque hash prefixes its input with `opaque:`. A JWT
signing input always starts with a base64url header (`eyJ...`), and base64url
has no `:`, so the two input sets can never overlap and neither output can be
passed off as the other. The prefix is load-bearing: removing it would remove
that separation.

## Transport rules

`serverConfig.ts` enforces:

| Setting | Default | Rule |
| --- | --- | --- |
| `OBSYNC_HOST` | `127.0.0.1` | Interface the server binds to |
| `PORT` | `3000` | |
| `OBSYNC_REQUIRE_TLS` | `false` on loopback, `true` otherwise | Must be `true` for any non-loopback host |
| `OBSYNC_TRUST_PROXY` | `false` | Must be `true` whenever TLS is required |
| `OBSYNC_TOKEN_SECRET` | none | At least 32 bytes; startup fails otherwise |

The backend never terminates TLS itself. With `OBSYNC_REQUIRE_TLS=true`, it
trusts `X-Forwarded-Proto: https` from a reverse proxy and rejects anything
else with `426` (HTTP) or an upgrade failure (WebSocket). Keep port 3000
unreachable from the network and let only the proxy talk to it.

The plugin applies the same rule on its side: `configureApiEndpoint()` refuses
a non-HTTPS URL unless the host is `127.0.0.1`, `::1` or `localhost`, and
derives `wss://` from `https://`.

### Remote deployment

```dotenv
OBSYNC_HOST=127.0.0.1
OBSYNC_REQUIRE_TLS=true
OBSYNC_TRUST_PROXY=true
```

Put a TLS reverse proxy in front, forward `X-Forwarded-Proto: https` for both
HTTP and WebSocket upgrades, and point the plugin at the proxy's HTTPS URL.

### Reaching the backend from other devices on your LAN

Binding the backend to a LAN address still counts as non-loopback, so it still
needs TLS through a proxy. The simplest setup keeps the backend on
`127.0.0.1` and runs [Caddy](https://caddyserver.com) on the same machine:

```text
# Caddyfile
:8443 {
	tls internal
	reverse_proxy 127.0.0.1:3000
}
```

```bash
caddy run --config Caddyfile
```

Use the remote-deployment configuration above for the backend. Open the
firewall for the proxy's port only:

```bash
# Linux (ufw)
sudo ufw allow 8443/tcp

# Windows (elevated prompt)
netsh advfirewall firewall add rule name="ObSync LAN proxy" dir=in action=allow protocol=TCP localport=8443

# macOS: System Settings -> Network -> Firewall -> Options, allow incoming connections for caddy
```

`tls internal` signs certificates with a local CA. Run `caddy trust` on the
proxy machine and install that root certificate on every other device (see
Caddy's documentation); until a device trusts it, Obsidian rejects the
connection. Then set the plugin's backend URL to `https://<lan-ip>:8443`.

## Rate limits

`LoginRateLimiter` keeps a sliding window of failures per key, in memory, with
at most 10,000 keys:

| Limiter | Key | Blocks after | Window and block |
| --- | --- | --- | --- |
| Login, per account | `account:<normalized e-mail>` | 5 failures | 15 min |
| Login, per IP | `ip:<address>` | 25 failures | 15 min |
| Password change | user id | 5 wrong current passwords | 15 min |

A block returns `429` with `Retry-After`. A successful login resets only the
account counter, so failures from the same IP against other accounts still
count (this is what stops password spraying).

## Account passwords

`npm run db:setup` creates the initial accounts with random temporary
passwords and prints them once. They are not stored anywhere in plain text.
Change them after the first sign-in under **Settings → ObSync → Account**
(`POST /api/auth/change-password`, which requires the current password).

An admin can reset the password of a `user` account from the user list
(`PATCH /api/users/:id/password`) without knowing it. The backend refuses this
for admin accounts: an admin changes their own password through the
self-service flow.

## Signing secret

```bash
openssl rand -base64 48
```

Store it only in `backend/.env` or a secret manager. Changing it invalidates
every access token and refresh token.

## Client-side storage

Access and refresh tokens are stored in Obsidian's `SecretStorage` under
`obsync-access-token` and `obsync-refresh-token`. The plugin's `data.json`
holds only the backend URL, the current user profile and the access-token
expiry.

## Related reference

- [AuthService](reference/plugin/authentication.md#authservice)
- [TokenService](reference/backend/authentication.md#tokenservice)
- [HTTP authentication endpoints](reference/backend/http.md#authentication)
- [WebSocket handshake](reference/backend/websocket.md#authentication-handshake)
