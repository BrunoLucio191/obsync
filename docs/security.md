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
OBSYNC_HOST=127.0.0.1
OBSYNC_REQUIRE_TLS=true
OBSYNC_TRUST_PROXY=true
```

Keep port `3000` inaccessible from the public network. The reverse proxy must
forward `X-Forwarded-Proto: https`, including WebSocket upgrade requests.

Point the plugin at the public HTTPS endpoint from **Settings → ObSync →
Backend connection** (only an admin can change it once an account is signed
in; anyone can set it before the first sign-in). The plugin refuses a
non-loopback endpoint that does not use HTTPS. Its WebSocket URL is derived
automatically as WSS.

### Reaching the backend from other devices on your LAN

The same rule applies even when you're not exposing anything to the public
internet: binding `OBSYNC_HOST` to a LAN address (e.g. `192.168.1.20`) so
your phone can reach it still counts as non-loopback, so it still requires
`OBSYNC_REQUIRE_TLS=true` and a proxy in front (`OBSYNC_TRUST_PROXY=true`).
There's no plain-HTTP LAN mode.

The proxy doesn't have to be public — it just has to terminate TLS somewhere
in front of the backend. The lightest option for a home network is
[Caddy](https://caddyserver.com), which generates and trusts a local
certificate automatically:

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

This proxies both the HTTP API and the WebSocket upgrades to the backend,
which stays bound to `127.0.0.1` — only the proxy needs to listen on your
LAN IP. Keep the backend's own configuration as the remote-deployment one
above (`OBSYNC_HOST=127.0.0.1`, `OBSYNC_REQUIRE_TLS=true`,
`OBSYNC_TRUST_PROXY=true`).

Open the firewall for the **proxy's** port, not the backend's:

```bash
# Linux (ufw)
sudo ufw allow 8443/tcp

# Windows (elevated PowerShell/cmd)
netsh advfirewall firewall add rule name="ObSync LAN proxy" dir=in action=allow protocol=TCP localport=8443

# macOS: System Settings -> Network -> Firewall -> Options, allow incoming
# connections for the caddy binary if the firewall is on (it's off by default)
```

`tls internal` signs certificates with a local CA that only the machine
running Caddy trusts automatically. Every *other* device (a phone, a second
laptop) needs to trust that CA once — run `caddy trust` on the proxy machine
to install it there, and consult Caddy's own documentation for exporting and
installing that root certificate on other devices and operating systems.
Until a device trusts it, Obsidian's WebSocket and HTTP clients will reject
the connection as an untrusted certificate, the same way a browser would.

Once trusted, point the plugin's backend URL field at
`https://<your-lan-ip>:8443`.

## Login rate limit

The backend tracks normalized accounts and source IPs independently. An account
is blocked after five failures in 15 minutes, while an IP is blocked after 25
failures in the same period. This limits both targeted guessing and password
spraying across multiple accounts. A block lasts 15 minutes and returns HTTP
`429` with `Retry-After`. A successful login resets the account counter; it does
not erase other failures made by that IP.

## Account passwords

`npm run db:setup` seeds the initial accounts with a random temporary password
per account, printed once to the terminal — it is not stored anywhere and
cannot be recovered afterward. Copy it down before closing the terminal.

Any account can change its own password from Obsidian, under **Settings →
ObSync → Conta → Trocar senha**, or by calling
[`POST /auth/change-password`](reference/backend/http.md#post-authchange-password)
directly. The current password must be supplied and is verified before the
change is applied. Change the temporary seed password the first time you sign
in.

An admin can also reset a `user`-role account's password directly from the
user administration list (a password field next to each user), without
knowing the current one. This does not apply to admin accounts: an admin
resetting their own password still goes through the self-service flow above,
which requires the current password.

## Signing secret

`OBSYNC_TOKEN_SECRET` must contain at least 32 random bytes. Generate one
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
