# Collaboration model

Each open Markdown note is represented by a `Y.Doc`. The editor binds to the `Y.Text` value named `codemirror`.

```ts
const ydoc = new Y.Doc();
const ytext = ydoc.getText('codemirror');
```

## Admin sessions

Admin sessions use one document for the editor, IndexedDB, and WebSocket provider.

```text
Editor <-> ydoc <-> IndexedDB
            ^
            `------> WebSocket <-> server
```

An editor update changes `ydoc`; the provider then sends the resulting Yjs update to the server. Server updates are applied to the same document and appear in the editor.

## User sessions

User sessions use separate private and network documents.

```text
Server -> networkDoc -> private ydoc -> Editor
                            |
                            `----------> IndexedDB
```

Document selection is role-dependent:

```ts
const networkDoc = user.role === 'user' ? new Y.Doc() : ydoc;
```

For a `user`, the WebSocket provider receives `networkDoc`, not the editor's private `ydoc`:

```ts
const provider = new WebsocketProvider(
	'ws://localhost:3000',
	roomName,
	networkDoc,
	{
		connect: false,
		params: { token },
		disableBc: true,
	},
);
```

Updates received by `networkDoc` are copied into the private document:

```ts
const onNetworkUpdate = (update: Uint8Array): void => {
	Y.applyUpdate(ydoc, update, provider);
};

networkDoc.on('update', onNetworkUpdate);
```

There is no listener that copies private updates back to `networkDoc`. Reopening a note restores the private document from IndexedDB, while the WebSocket handshake uses only the separate network document.

## Room lifecycle

When a Markdown note becomes active, the plugin:

1. closes the previous room;
2. creates the role-appropriate documents;
3. restores the local document from IndexedDB;
4. attaches the CodeMirror collaboration extension;
5. connects the WebSocket provider;
6. publishes awareness information for the authenticated account.

When the room closes, the plugin removes awareness and update listeners, destroys the provider, closes IndexedDB persistence, and destroys the Yjs documents.

## Awareness

Awareness data contains transient presence information such as the account name and cursor identity. It is not part of the persisted note state. The backend validates awareness ownership so one connection cannot impersonate another authenticated account.
