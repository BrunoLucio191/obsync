# Plugin collaboration API

The collaboration layer has two levels. `CollaborationController` follows the
active Obsidian note. The functions in `collab.ts` construct and dispose the
Yjs room bound to that note.

## CollaborationController

Source: [`plugin/obSync/src/collab/CollaborationController.ts`](../../../plugin/obSync/src/collab/CollaborationController.ts)

```ts
new CollaborationController(app: App, auth: AuthService)
```

### Public properties

| Property | Type | Meaning |
| --- | --- | --- |
| `editorExtensions` | `Extension[]` | Mutable extension array registered once with Obsidian |
| `currentPath` | `string | null` | Markdown path associated with the active room |

### Public methods

#### `scheduleActiveRoomSync()`

```ts
scheduleActiveRoomSync(): void
```

Schedules a zero-delay check of the active file. The delay lets Obsidian finish
updating `workspace.getActiveFile()` after workspace events.

#### `join()`

```ts
join(filePath: string): Promise<void>
```

Closes the previous room, prepares local persistence, restores editor text,
installs the CodeMirror Yjs extension, and then enables network connection. A
generation counter discards completion from an outdated asynchronous join.

#### `disconnect()`

```ts
disconnect(): void
```

Invalidates pending room work, removes the editor extension, destroys the room,
and clears `currentPath`.

#### Other lifecycle methods

| Method | Behavior |
| --- | --- |
| `refreshAfterProfileChange()` | Recreates the active room using the current role and identity |
| `disconnectIfAffected(path)` | Disconnects when a deleted path contains the active note |
| `destroy()` | Cancels the scheduled active-file check and disconnects |

## `setupCollabRoom()`

Source: [`plugin/obSync/src/collab/collab.ts`](../../../plugin/obSync/src/collab/collab.ts)

```ts
setupCollabRoom(
	fileName: string,
	user: CollaborationUser,
	requestWebSocketTicket: () => Promise<string | null>,
	onUserJoined: (name: string) => void,
	onUserLeft: (name: string) => void,
): Promise<PreparedCollabRoom | null>
```

Creates the Yjs documents, IndexedDB persistence, awareness handlers, and a
disconnected `WebsocketProvider`. Network connection starts only when the
caller invokes `PreparedCollabRoom.connect()`.

Document ownership depends on the current role:

```ts
const networkDoc = user.role === 'user' ? new Y.Doc() : ydoc;
```

For an admin, the editor and provider share `ydoc`. For a normal user, the
provider uses `networkDoc`; received server updates are copied into the private
editor document, but private editor updates do not flow back to the provider.

Every connection and reconnection calls `requestWebSocketTicket()` and places
the ticket in `Sec-WebSocket-Protocol`.

## Room utility functions

### `closeCollabRoom()`

```ts
closeCollabRoom(): void
```

Removes awareness and browser listeners, stops reconnect timers, destroys the
provider and documents, and releases IndexedDB persistence.

### `getCurrentCollabRoomPath()`

```ts
getCurrentCollabRoomPath(): string | null
```

Returns the path stored by the module-level active room.

## Offline persistence

Source: [`plugin/obSync/src/collab/OfflinePersistence.ts`](../../../plugin/obSync/src/collab/OfflinePersistence.ts)

### `initializeOfflinePersistence()`

```ts
initializeOfflinePersistence({
	documentId,
	ydoc,
	namespace,
}: OfflinePersistenceOptions): OfflinePersistenceHandle
```

Creates or reuses the IndexedDB provider for a `Y.Doc`. The returned handle
contains the database name, the provider, a `ready` promise, and `destroy()` and
`clear()` lifecycle methods.

Namespaces identify ownership. Admin history uses a global namespace; user
history uses an account-specific private namespace.

## Related references

- [Collaboration concepts](../../collaboration.md)
- [Collaboration types](types.md#collaboration)
- [WebSocket protocol](../backend/websocket.md)
