# Troubleshooting

## Confirm the installed plugin build

Build the plugin from the repository root:

```bash
npm run build --workspace=obSync
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
[Audit] Update Yjs global bloqueado
```

When a private edit appears in shared state, check the following in order:

1. the client is running the current `main.js`;
2. `/auth/me` resolves the client account as `user`;
3. the running backend contains the current Yjs authorization check;
4. the same Obsidian profile did not reopen the private history under an admin account;
5. the content was not already published by an admin before the test began.

