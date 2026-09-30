# Storage

This page lists every place ObSync keeps data, on the backend and on each
client, and why each one exists. Everything under `backend/data/` is runtime
data: it is disposable during development, and there are no migrations.

## Backend (`backend/data/`)

All paths are defined in `backend/paths.ts` and resolved from the backend
folder, so the working directory the server is started from does not matter.

| Path | Contents | Written by |
| --- | --- | --- |
| `users.sqlite` (+ `-wal`, `-shm`) | Accounts and roles | `npm run db:setup`, `DBServices` |
| `vault/` | The canonical shared vault, as ordinary files | `FileManager`, `YjsPersistence` |
| `yjs-state/<path>.yjs-state` | Binary Yjs state of each note that was ever opened in collaboration | `YjsPersistence` |
| `gene.json` | The vault gene (fingerprint used by the initial download) | `Gene` |
| `zips/<clientId>.zip` | Temporary ZIP of the vault for one initial download, deleted 15 s after sending | `SyncFilesController.initSync` |

`vault/` must exist before the backend starts. Nothing creates it, and the gene
watcher crashes the process if it is missing (see
[Known issues](known-issues.md#backend-startup-crashes-when-datavault-is-missing)).

### Why notes are stored twice

The `.md` file in `vault/` is the readable copy: you can open the folder in
Obsidian, back it up or grep it, and it is what the initial ZIP and
`GET /api/sync/getFile` serve. The `.yjs-state` file is the authority for
collaboration: it keeps the identity of every Yjs operation, which clients
need to merge their cached documents without duplicating text. The full
explanation is in [Collaboration](collaboration.md#persistence-backendserveryjspersistencets).

Deleting or renaming a path through the HTTP API updates both. A note that was
never opened in collaboration has no `.yjs-state`; the first time a room opens
for it, its state is seeded from the `.md` file.

## SQLite user database

### Schema

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,          -- normalized: NFC, trimmed, lowercase
  name          TEXT NOT NULL,                 -- display name as typed
  name_key      TEXT NOT NULL UNIQUE,          -- pt-BR case-folded name, for duplicate detection
  password_hash TEXT NOT NULL,                 -- "<salt>:<scrypt hash>", hex
  role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  color         TEXT NOT NULL CHECK(color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
);
```

The database uses WAL mode. It is opened with Node's built-in `node:sqlite`
module, so there is no native dependency to install.

### Lifecycle

The server never creates the database. Setup is an explicit, separate step:

```bash
npm run db:setup
```

`createUserDatabase()`:

1. refuses to run if the file already exists;
2. creates the schema;
3. inserts the seed accounts (defined in `UserDB.#createInitialUsers()`), each
   with a random temporary password and a random cursor color;
4. promotes the first active account to `admin`;
5. prints each e-mail and temporary password once;
6. deletes the partial file and its sidecars if anything fails.

At startup, `openUserDatabase()` requires the file, the `users` table, and at
least one active admin. If any is missing, the server exits with a message
naming the setup command.

To start over during development, stop the backend, delete
`backend/data/users.sqlite*`, and run `npm run db:setup` again.

## Plugin

| Data | Where | Why there |
| --- | --- | --- |
| Access and refresh tokens | Obsidian `SecretStorage` (`obsync-access-token`, `obsync-refresh-token`) | Kept out of `data.json`, which is a plain file in the vault |
| Saved vault gene | `SecretStorage` (`obsync-vault-gene-<vault name>`) | Survives restarts; the vault name is included because mobile shares secrets across vaults |
| Backend URL, current user, access-token expiry | Plugin `data.json` (`ObSyncConfig`) | Non-secret configuration |
| Yjs history per note | IndexedDB, one database per note and namespace | Offline editing and fast note opening |
| Merge base (regular users) | `<plugin folder>/sync-base/index.json` and `<hash>.txt` | Last server version of each file, for three-way merges |

### IndexedDB namespaces

```text
Admin: obsync:v3:global:<encoded note path>
User:  obsync:v3:private:<encoded e-mail>:<encoded note path>
```

The namespace encodes ownership. An admin's history is publishable; a regular
user's history is private to that account. Keeping them apart prevents an
admin signing in on the same Obsidian profile from loading a user's private
edits into a document connected to the server.

## Related reference

- [Plugin collaboration API](reference/plugin/collaboration.md#offline-persistence)
- [YjsPersistence](reference/backend/services.md#yjspersistence)
- [Database lifecycle](reference/backend/services.md#database-lifecycle)
