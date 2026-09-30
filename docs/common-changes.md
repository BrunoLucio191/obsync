# Common changes

Where to edit for the changes people make most often, with the pieces that are
easy to forget. Read [Architecture](architecture.md) first if a module name is
unfamiliar.

## Add an HTTP endpoint

Example: `PATCH /api/users/:id/email`.

1. **Route**: register it in the router of its domain,
   `backend/Server/ExpressServer/routes/route.users.ts`. Paths are relative to
   the mount prefix. Pick the middleware chain from
   [Authorization](permissions.md#http): mutations need `authMiddleware`,
   usually `adminMiddleware`, and `clientIdMiddleware`.
   ```ts
   this.router.patch(
     "/:id/email",
     this.#authMiddleware,
     this.#adminMiddleware,
     this.#clientIdMiddleware,
     this.#usersController.changeEmail,
   );
   ```
2. **Controller**: add the handler as an arrow-function property (so `this`
   stays bound when Express calls it) in
   `controllers/UsersController.ts`. Validate input first, then run the change
   inside the client's queue with a key that names the resource and the
   operation:
   ```ts
   const queue = this.#queueManager.getOrCreateQueue(res.locals.clientId as string);
   await queue.addTask(async () => {
     const result = await this.#dbService.updateUserEmail(userId, email);
     if (!result.ok) {
       res.status(userMutationErrorStatus(result)).json({
         error: UserMutationErrorMessage(result),
         reason: result.reason,
       });
       return;
     }
     res.json({ user: result.user });
   }, `user:${userId}:changeEmail`);
   ```
3. **Data layer**: add the query to `users/DBServices.ts`, returning a
   `UserMutationResult`. If the change affects what a user may do, call
   `this.#event.emitAuthorizationChanged(userId)` so their live sockets are
   closed and reopened with fresh permissions.
4. **New failure reason**: add it to `UserMutationResult` in
   `auth/auth.types.ts` and to both functions in
   `routes/mutationMessage/userMessageMutation.ts`.
5. **Plugin client**: add a method to `auth/UserAdminService.ts` (or
   `AuthService` for self-service actions), expose it on `ObSync` and in the
   `SettingsController` interface if the settings UI needs it.
6. **Strings**: add keys to both `i18n/locales/en.ts` and `pt.ts`, and map the
   new reason in `i18n/backendErrors.ts`.
7. **Docs**: [HTTP API](reference/backend/http.md) and, if permissions changed,
   [Authorization](permissions.md).

## Add a vault operation that other clients must see

1. Add the route and handler in `route.syncFiles.ts` and
   `SyncFilesController.ts`, inside `queue.addTask()` with a `file:<path>:<op>`
   key.
2. Keep the Yjs side consistent: if the operation removes or moves a path, call
   `markPathDeleted`, `deletePersistedStateUnderPath` or
   `renamePersistedStatePath` on `collaborationServer`.
3. Call `publishVaultChange()` with `originClientId: clientId`. If it is a new
   event type, extend `VaultChange` in **both** `backend/syncEvents.ts` and
   `plugin/obSync/src/vault/VaultChange.ts`; nothing checks that they match.
4. Handle the event in `RemoteVaultChangeService.#applyChange()`, muting every
   path before writing, and routing regular users through
   `ServerVersionMerger` when file content is involved.
5. If an Obsidian event should trigger it, publish from `SyncVaultChanges`.

## Change what a regular user may do

Change it on the backend first (middleware, controller check, or
`syncMessageHandler` for Yjs). Then adjust the plugin to match:
`AuthService.isAdmin()`/`isReadOnlyUser()` callers, `SyncVaultChanges`, the
`networkDoc` split in `collab.ts`, and the settings visibility in
`ObSyncSettingTab`. Changing only the plugin changes nothing for security.

## Change a timeout, limit or lifetime

| Value | Where |
| --- | --- |
| Access token (15 min), refresh token (30 days), ticket (30 s) | Constants at the top of `backend/auth/TokenService.ts` |
| Refresh one minute before expiry | `REFRESH_EARLY_MS` in `plugin/obSync/src/auth/AuthService.ts` |
| Login and password-change limits | `LoginRateLimiter` instances in `ExpressServer` constructor |
| WebSocket message size (16 MiB), room queue (1,024), awareness entries (128) | `backend/yjs/yjs.const.ts` |
| Heartbeat (30 s) | `HEARTBEAT_INTERVAL_MS` in `backend/Server/WebSocketServer.ts` |
| Reconnect backoff, presence leave delay, Yjs resync interval | `plugin/obSync/src/collab/collab.cons.ts` |
| Mute duration (2 s) | `PathMuteRegistry` constructor default |
| JSON body (25 MB), binary upload (600 MB) | `ExpressServer.initializeMiddleware()`, `route.syncFiles.ts` |
| ZIP cleanup delay (15 s) | `SyncFilesController.initSync` |

## Add or change UI text

Every visible string goes through `t('key')`. Add the key to
`plugin/obSync/src/i18n/locales/en.ts` and `pt.ts` with the same name. The
language follows Obsidian's own setting, not the operating system's.

## Add a settings control

Settings sections live in `plugin/obSync/src/settings/`. Each section returns
Obsidian setting definitions; `ObSyncSettingTab.getSettingDefinitions()` decides
which sections are visible for the current state (no backend, signed out,
user, admin). Sections call the plugin only through `SettingsController`, so a
new action needs a method there and on `ObSync`.

## Change the seed accounts

Edit the `users` array in `UserDB.#createInitialUsers()`
(`backend/users/UserDB.ts`). The first active account becomes admin. The seed
only runs in `npm run db:setup`, so delete the database and run it again.

## Test a change

The fastest check for backend and plugin code is to run both against each
other: start the backend, rebuild the plugin with `npm run dev` in
`plugin/obSync/`, and reload the plugin in two Obsidian vaults signed in as an
admin and a user. `node backend/scripts/generateRandomVault.ts` creates a
vault large enough to exercise the initial download.

Type-check both halves before committing:

```bash
cd backend && npx tsc --noEmit -p tsconfig.json
cd plugin/obSync && npx tsc -noEmit -skipLibCheck
```
