# WebSocket API

ObSync exposes two WebSocket channels through the same HTTP server. Remote
deployments use WSS; loopback development may use WS.

## Authentication handshake

Bearer tokens are not accepted in the URL. The client first requests a ticket
from `POST /auth/ws-ticket`, then includes it as a WebSocket subprotocol:

```ts
const socket = new WebSocket(url, [
	`obsync-ticket.${ticket}`,
]);
```

The server performs these checks during upgrade:

1. TLS is present when required;
2. the subprotocol contains a correctly formatted ticket;
3. the ticket exists and has not been attempted before;
4. the ticket was issued for the requested channel;
5. the ticket and access token have not expired;
6. the backend session and user are still active.

The ticket is removed on the first handshake attempt, whether that attempt
succeeds or fails.

## `/system`

Direction: server to client.

The backend serializes each `VaultChange` as JSON and sends it to every open
system-channel client:

```json
{
  "type": "modify",
  "path": "notes/example.md",
  "content": "Updated text",
  "originClientId": "client UUID"
}
```

Client messages are not valid on this channel. Sending one causes close code
`1008`.

## `/<encoded-note-path>`

Direction: bidirectional protocol, role-dependent write authorization.

The path identifies a Yjs room. The transport carries Yjs sync messages and
awareness updates. Admin document updates may modify shared state. User
document updates are rejected by the backend, while awareness and incoming
shared updates remain available.

Each accepted connection records the authenticated user and a
`canWriteGlobal` permission derived from the backend role. Client-provided role
values are never used for authorization.

## Reconnection

A ticket cannot be reused. Both `SystemChannel` and the Yjs provider request a
new ticket before every reconnect. A room does not connect until IndexedDB
restoration has completed.

## Connection lifetime

- A heartbeat ping runs every 30 seconds.
- Connections that fail to answer are terminated.
- A connection closes when the access token used to issue its ticket expires.
- Session revocation closes every connection for that session.
- User role, status, name, or deletion events close connections for that user.

## Close codes

| Code | Meaning in ObSync |
| --- | --- |
| `1008` | Policy violation, missing authorization, or client mutation on `/system` |
| `1009` | WebSocket message exceeded the configured size |
| `1011` | Unexpected Yjs server failure |
| `1013` | Per-document message queue overloaded |
| `4003` | Access expired, session revoked, or authorization changed |

HTTP upgrade failures use `400`, `401`, or `426` before a WebSocket connection
is established.

## Payload limit

Both WebSocket servers use `MAX_WS_MESSAGE_BYTES`, currently 16 MiB, and disable
per-message deflate.
