# Troubleshooting

Symptoms first, then the cause and the fix. Most problems fall into three
groups: the backend does not start, the plugin cannot connect or sign in, or
changes do not arrive where they should.

## Backend does not start

### `npm run dev` fails with `Cannot find module .../server.ts`

The backend scripts point to a file that does not exist
([Known issues](known-issues.md#backend-npm-start-and-npm-run-dev-point-to-a-missing-file)).
Start it from `backend/`:

```bash
cd backend
node --watch main.ts
```

### `ENOENT: no such file or directory, watch '.../backend/data/vault'`

The vault folder does not exist yet. Create it and start again:

```bash
mkdir -p backend/data/vault
```

### `[Database] User database not found at: ...`

The database has not been created. From the repository root:

```bash
npm run db:setup
```

The command never overwrites an existing database. If the message says the
database is **invalid** instead (no `users` table, or no active admin), back
the file up and inspect it before deleting it; during development you can
delete `backend/data/users.sqlite*` and run the setup again.

### `OBSYNC_TOKEN_SECRET must contain at least 32 random bytes.`

`backend/.env` is missing or the secret is too short. Generate one with
`openssl rand -base64 48`.

### `OBSYNC_REQUIRE_TLS must be true when OBSYNC_HOST is not loopback.`

You bound the backend to a LAN or public address. Either keep
`OBSYNC_HOST=127.0.0.1`, or set `OBSYNC_REQUIRE_TLS=true` and
`OBSYNC_TRUST_PROXY=true` and put a TLS proxy in front
([Security](security.md#transport-rules)).

### `node: ... Unknown file extension ".ts"` or `node:sqlite` not found

The backend runs TypeScript directly and uses the built-in SQLite module. Use a
current Node.js release; the project is developed on Node 26.

## Plugin cannot connect or sign in

### Nothing happens at startup

If no backend URL is saved, the plugin intentionally does nothing (it will not
open a login prompt for a backend it does not know). Set the URL in
**Settings → ObSync**.

### "HTTPS is required" when saving the URL

The plugin refuses plain HTTP for any host other than `127.0.0.1`, `::1` or
`localhost`. Use HTTPS through a proxy for anything else.

### The plugin cannot reach a local backend

`OBSYNC_HOST=127.0.0.1` listens only on IPv4 loopback. `localhost` may resolve
to IPv6 `::1` first, where nothing is listening. Use `http://127.0.0.1:3000`.

### Signed out after restarting the backend

Expected: sessions are held in memory, so a restart revokes them. Sign in
again.

### `429 Too many login attempts`

Five failures for one account, or 25 from one IP, within 15 minutes block
further attempts for 15 minutes. The response has a `Retry-After` header.
Restarting the backend also clears the counters.

### WebSocket closes right after opening

Check the close code (the backend logs most of them):

| Code | Likely cause |
| --- | --- |
| HTTP `401` on upgrade | Ticket missing, reused, expired, or for the other channel |
| HTTP `426` on upgrade | TLS required but the request did not come through a trusted HTTPS proxy |
| `1008` | Note path invalid or deleted, or a message was sent on `/system` |
| `1011` | The room failed to load its state from disk |
| `1013` | The room was shutting down, or its message queue was full; the client reconnects |
| `4003` | Access token expired, session revoked, or the user's role, status or name changed |

## Changes do not arrive

### The initial download says the vault is up to date, but files are missing

The saved gene matches the server's, so the server answered `204`. To force a
full download, delete the `obsync-vault-gene-<vault name>` secret from
Obsidian's secret storage, or make any change in `backend/data/vault/` so the
gene changes.

### An admin's rename, create or delete does not appear on other clients

1. The acting client must be an `admin`; regular users never publish.
2. Look for `[Sync] Error in ...` on the backend.
3. Check that the other clients have a `/system` connection (they reconnect
   automatically with backoff up to 30 s).
4. The acting client ignores its own event by design (`originClientId`).

### A regular user sees conflict markers in a file

Both the user and an admin changed the same lines since the user last received
the file. The merge keeps both versions between markers labelled "your
version" and "server version". Binary files are saved as
`name (server version).ext` instead.

## Verify that a regular user's edits stay private

1. Open the same note in an admin client and a user client.
2. Type a unique marker in the admin client; it should appear in both.
3. Type a different marker in the user client.
4. Restart the user client and reopen the note: the user's marker is still
   there (restored from IndexedDB).
5. Reload the note in the admin client: the user's marker must not appear.

If it does appear, check in order:

1. the user client runs the current `main.js`;
2. `GET /api/auth/me` returns `role: "user"` for that account;
3. the backend logs `[Audit] Global Yjs update blocked` when the user types;
4. the same Obsidian profile did not open the note as an admin first;
5. the content was not already published by an admin before the test.

## Inspecting state during development

```bash
# Accounts and roles
sqlite3 backend/data/users.sqlite 'select id, email, role, active from users order by id;'

# Current vault gene
cat backend/data/gene.json

# Which notes have Yjs state
find backend/data/yjs-state -name '*.yjs-state'
```

To test with a larger vault, `node backend/scripts/generateRandomVault.ts`
fills `backend/data/vault/` with random folders and notes.

## Reference during debugging

- [HTTP API and status codes](reference/backend/http.md)
- [WebSocket close codes](reference/backend/websocket.md#close-codes)
- [Known issues](known-issues.md)
