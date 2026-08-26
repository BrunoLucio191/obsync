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
3. inserts the initial users defined by the seed, each with its own random
   temporary password;
4. promotes the first active seeded user to `admin`;
5. prints every seeded email and its temporary password to the terminal —
   this is the only time they are shown;
6. removes a newly created database if setup fails before completion.

At runtime, the backend validates that the database exists, contains the `users` table, and has an active administrator. Startup stops with the setup command in the terminal message when validation fails.

See [Security: account passwords](security.md#account-passwords) for rotating
these temporary passwords after first sign-in.

## Client storage

Access and refresh tokens are stored with Obsidian `SecretStorage`, not in the
plugin's `data.json`. The JSON configuration keeps only non-secret session
metadata: the current user and access-token expiration time.

The plugin stores Yjs updates in IndexedDB. Database names include the note path and an ownership namespace.

```text
Admin: obsync:v3:global:<encoded-note-path>
User:  obsync:v3:private:<encoded-email>:<encoded-note-path>
```

The admin namespace contains publishable shared history. Each user namespace contains private history for one account. This prevents an admin session in the same Obsidian profile from restoring and publishing a user's private cache.

## Related reference

- [Plugin collaboration API](reference/plugin/collaboration.md#offline-persistence)
- [YjsPersistence](reference/backend/services.md#yjspersistence)
- [Database lifecycle](reference/backend/services.md#database-lifecycle)
