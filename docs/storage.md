# Storage

## Backend storage

| Data | Path |
| --- | --- |
| Users and roles | `backend/data/users.sqlite` |
| Shared Markdown vault | `backend/data/vault/` |
| Persistent Yjs state | `backend/data/yjs-state/` |

The Markdown files provide the shared vault contents. Binary Yjs state preserves CRDT history across backend restarts.

SQLite sidecar files such as `users.sqlite-wal` and `users.sqlite-shm` are runtime data and should not be committed.

## User database lifecycle

The backend does not create `users.sqlite` during startup. Initialize it explicitly from the repository root:

```bash
npm run db:setup
```

The setup command:

1. refuses to overwrite an existing database;
2. creates the `users` schema;
3. inserts the initial users defined by the seed;
4. promotes the first active seeded user to `admin`;
5. removes a newly created database if setup fails before completion.

At runtime, the backend validates that the database exists, contains the `users` table, and has an active administrator. Startup stops with the setup command in the terminal message when validation fails.

## Client storage

The plugin stores Yjs updates in IndexedDB. Database names include the note path and an ownership namespace.

```text
Admin: your-mon:v2:global:<encoded-note-path>
User:  your-mon:v2:private:<encoded-email>:<encoded-note-path>
```

The admin namespace contains publishable shared history. Each user namespace contains private history for one account. This prevents an admin session in the same Obsidian profile from restoring and publishing a user's private cache.

## Legacy namespace

Earlier builds used a role-independent database name:

```text
your-mon:<encoded-note-path>
```

User sessions import this legacy state into their private namespace to retain existing local edits. Admin sessions do not import it because the legacy database may contain private user history.
