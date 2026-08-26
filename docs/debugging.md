# Troubleshooting

## Session is cleared after restarting the backend

Backend sessions and refresh-token hashes are held in memory. A backend restart
intentionally revokes them. Sign in again from the plugin settings.

## Backend reports that HTTPS is required

For local development, keep `OBSYNC_HOST=127.0.0.1` and
`OBSYNC_REQUIRE_TLS=false`. For a remote installation, configure a TLS reverse
proxy, enable `OBSYNC_REQUIRE_TLS` and `OBSYNC_TRUST_PROXY`, and make sure the
proxy sends `X-Forwarded-Proto: https` for both HTTP and WebSocket requests.

## Plugin can't reach a local backend

The backend's default `OBSYNC_HOST=127.0.0.1` binds only the IPv4 loopback
interface. If the plugin's **Backend server URL** setting uses `localhost`
instead of `127.0.0.1`, the client's DNS/loopback resolution can prefer IPv6
(`::1`), where nothing is listening, and the connection fails or stalls
before falling back to IPv4. Use `http://127.0.0.1:<port>` directly for local
testing to avoid this; it always reaches the exact interface the backend
opened.

## User database is missing

Backend startup reports the database path and exits when `backend/data/users.sqlite` has not been initialized. Create and seed it from the repository root:

```bash
npm run db:setup
```

The command does not overwrite an existing database. If an existing database is invalid, back it up and inspect it before removing or replacing it.

## Confirm the installed plugin build

Build the plugin from the repository root:

```bash
npm run build --workspace=plugin/obSync
```

Confirm that the resulting `plugin/obSync/main.js` is the file installed in the target vault. Obsidian must reload the plugin after the bundle is replaced.

## Confirm the authenticated role

The settings page shows the current account and role. Session validation uses `/auth/me`, and the backend resolves the current role from its database rather than trusting the role stored in the token payload.

For database inspection during local development:

```bash
sqlite3 backend/data/users.sqlite \
  'select id, email, role, active from users order by id;'
```

## Verify private-edit isolation

1. Open the same note in an admin client and a user client.
2. Enter a unique marker from the admin client and wait for both clients to display it.
3. Enter a different marker from the user client.
4. Restart the user client and reopen the note.
5. Open or reload the note in the admin client.

The admin marker should be shared. The user marker should remain visible only in that user's local client, including after the restart.

## Backend audit messages

The backend reports rejected Yjs writes with:

```text
[Audit] Global Yjs update blocked
```

When a private edit appears in shared state, check the following in order:

1. the client is running the current `main.js`;
2. `/auth/me` resolves the client account as `user`;
3. the running backend contains the current Yjs authorization check;
4. the same Obsidian profile did not reopen the private history under an admin account;
5. the content was not already published by an admin before the test began.

## Reference during debugging

- [HTTP API and status codes](reference/backend/http.md)
- [WebSocket close codes](reference/backend/websocket.md#close-codes)
- [Plugin synchronization services](reference/plugin/synchronization.md)
