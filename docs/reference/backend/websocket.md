# WebSocket API

Two kinds of WebSocket share the HTTP server: `/system` for vault events and
one path per note for Yjs collaboration. Any path other than `/system` is
treated as a note. Remote deployments use WSS; loopback development may use WS.

## Authentication handshake

Tokens are never accepted in the URL. The client gets a ticket from
`POST /api/auth/ws-ticket` and offers it as a subprotocol:

```ts
const socket = new WebSocket(`${wsBaseUrl}/system`, [`obsync-ticket.${ticket}`]);
```

During the HTTP upgrade (`WebSocketServer.#handleUpgrade`) the server checks,
in order:

1. TLS, when required (`426` otherwise);
2. the URL parses (`400` otherwise); the channel is `system` for `/system` and
   `yjs` for anything else;
3. a subprotocol `obsync-ticket.<43 base64url characters>` is present;
4. the ticket exists; it is **deleted at this point**, so it is consumed even
   if a later check fails;
5. it was issued for this channel, it and its access token have not expired,
   the session still exists, and the user still exists.

Any failure answers `401` and destroys the socket. On success the connection is
bound to the user and session, and a timer closes it with `4003` when the
access token expires.

## `/system`

Direction: server to client only.

After every successful vault mutation the server sends the `VaultChange` as
JSON to every open `/system` socket:

```json
{ "type": "create", "path": "Assets/diagram.png", "isFolder": false, "isBinary": true, "originClientId": "9b1e..." }
{ "type": "modify", "path": "Projects/plan.md", "content": "# Plan v2", "originClientId": "9b1e..." }
{ "type": "delete", "path": "Projects", "isFolder": true, "originClientId": "9b1e..." }
{ "type": "rename", "oldPath": "a.md", "newPath": "b.md", "isFolder": false, "originClientId": "9b1e..." }
```

Clients ignore events whose `originClientId` is their own. Any message sent by
a client is logged (`[Audit] Mutation message refused on the /system channel`)
and closes the socket with `1008`.

## `/<encoded note path>`

Direction: both ways; writes only from admins.

The path is the note's vault path, URI-encoded, for example
`/Projects%2Fplan.md`. The server decodes it, normalizes slashes, and rejects
empty paths and `.`/`..` segments (`1008`). Connections for a deleted path are
refused (`1008`).

Messages are binary and use the `y-websocket` framing: a varint message type
followed by the payload.

| Type | Name | Client → server | Server → client |
| --- | --- | --- | --- |
| `0` | sync | `SyncStep1` answered for every role; `SyncStep2`/`Update` applied for admins only, dropped and audited otherwise | `SyncStep1` on connect, `SyncStep2` answers, `Update` broadcasts |
| `1` | awareness | Accepted subject to ownership checks | Broadcast of changed entries |
| `2` | auth | Rejected; closes the socket with `1007` | never sent |
| `3` | query awareness | Answered with the current awareness snapshot | |

On connect, after the room has loaded, the server sends its `SyncStep1` and the
current awareness states.

Limits: 16 MiB per message (`MAX_WS_MESSAGE_BYTES`, also the `ws` max
payload), 128 awareness entries per message, 1,024 pending messages per room.
Per-message deflate is disabled.

## Connection lifetime

- The server pings every 30 s and terminates sockets that did not answer the
  previous ping.
- A socket closes with `4003` when its access token expires, its session is
  revoked, or the user's name, role or status changes or the user is deleted.
- Clients reconnect with a **new ticket** every time. The plugin's Yjs room
  disables `y-websocket`'s own reconnect for this reason.
- A note room does not connect until the client has loaded its IndexedDB
  cache.

## Close codes

| Code | Meaning in ObSync |
| --- | --- |
| `1003` | Non-binary message on a note socket |
| `1007` | Invalid Yjs payload, or a message of type auth or unknown |
| `1008` | Invalid or deleted note path, path deleted while connected, or a message on `/system` |
| `1009` | Message larger than 16 MiB |
| `1011` | The room failed to load, or an unexpected server error |
| `1013` | Room shutting down, or the room's message queue is full; reconnect later |
| `4003` | Access token expired, session revoked, or authorization changed |

Upgrade failures happen before the WebSocket exists and use HTTP `400`, `401`
or `426`.
