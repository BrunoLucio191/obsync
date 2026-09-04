# Plugin synchronization API

File synchronization is separate from character-level Yjs collaboration. These
services handle initial download and whole-vault create, modify, delete, and
rename events.

## SyncInitialVault

Source: [`plugin/obSync/src/sync/SyncInitialVault.ts`](../../../plugin/obSync/src/sync/SyncInitialVault.ts)

```ts
new SyncInitialVault(
	app: App,
	auth: AuthService,
	mutedPaths: PathMuteRegistry,
)
```

### `sync()`

```ts
sync(): Promise<void>
```

Downloads `/api/sync/initSync` as a ZIP and writes its entries through the vault
adapter. Paths are muted before each local write so Obsidian's vault events do
not publish the downloaded files back to the server.

For a normal user, an existing local file is preserved. An admin receives the
shared file content.

## SyncVaultChanges

Source: [`plugin/obSync/src/sync/SyncVaultChanges.ts`](../../../plugin/obSync/src/sync/SyncVaultChanges.ts)

```ts
new SyncVaultChanges(plugin, auth, mutedPaths, collaboration)
```

### `initialize()`

```ts
initialize(): void
```

Registers Obsidian `create`, `delete`, `modify`, and `rename` vault listeners.
Before publishing, each handler verifies that:

1. the current profile is an admin;
2. the path was not muted by a remote operation;
3. the access token is fresh;
4. the refreshed profile is still an admin.

The active Markdown file is excluded from whole-file `modify` requests because
Yjs owns that file while its room is active.

## SystemChannel

Source: [`plugin/obSync/src/sync/SystemChannel.ts`](../../../plugin/obSync/src/sync/SystemChannel.ts)

```ts
new SystemChannel(
	auth: AuthService,
	remoteChanges: RemoteVaultChangeService,
)
```

### `connect()`

```ts
connect(): void
```

Invalidates the current connection, requests a one-use `system` ticket, and
opens the receive-only `/system` WebSocket. Events originating from the same
`clientId` are ignored.

### `disconnect()`

```ts
disconnect(): void
```

Invalidates pending ticket requests, clears reconnect timers, and closes the
current socket.

The service reconnects with a new ticket after an unexpected close. Close code
`4003` triggers session refresh first.

## RemoteVaultChangeService

Source: [`plugin/obSync/src/vault/RemoteVaultChangeService.ts`](../../../plugin/obSync/src/vault/RemoteVaultChangeService.ts)

```ts
new RemoteVaultChangeService(app, auth, mutedPaths, collaboration)
```

### `apply()`

```ts
apply(change: VaultChange): Promise<void>
```

Applies one server event to the local vault. It creates missing parent folders,
mutes affected paths, and disconnects collaboration before deleting the active
note. Existing user files are protected from remote create and modify events;
delete and rename events still update shared structure.

## PathMuteRegistry

Source: [`plugin/obSync/src/vault/PathMuteRegistry.ts`](../../../plugin/obSync/src/vault/PathMuteRegistry.ts)

```ts
new PathMuteRegistry(muteDurationMs = 2_000)
```

| Method | Description |
| --- | --- |
| `mute(path)` | Marks a path until the configured expiration time |
| `isMuted(path)` | Checks the path and descendants of every active muted path |
| `clear()` | Removes all entries |
| `PathMuteRegistry.contains(root, candidate)` | Tests whether two paths are equal or the candidate is under the root |

```ts
mutedPaths.mute('Projects');
mutedPaths.isMuted('Projects/note.md'); // true
```

## Related references

- [VaultChange](types.md#vaultchange)
- [HTTP sync endpoints](../backend/http.md#shared-vault-sync)
- [Storage](../../storage.md)
