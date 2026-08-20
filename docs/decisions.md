# Design decisions

## Sessions use short access tokens and rotating refresh tokens

Access tokens last 15 minutes and are verified against both their signed claims
and an active backend session. Refresh tokens rotate on every renewal and are
stored only as HMAC hashes in backend memory. This makes logout immediately
revocable without storing a long-lived bearer token in SQLite.

The tradeoff is intentional: restarting the backend revokes all sessions. A
persistent session store can replace the in-memory map later if uninterrupted
sessions across deployments become a requirement.

## WebSockets use one-use tickets

The browser WebSocket API cannot add an `Authorization` header. Putting the
normal bearer token in a query string would expose it to URL logging. The client
therefore exchanges its access token for a 30-second, channel-scoped ticket and
sends that ticket as a WebSocket subprotocol. Every reconnection obtains a new
ticket.

## Remote transport terminates TLS at a reverse proxy

The Node.js service defaults to loopback-only HTTP for local development. A
non-local deployment must require TLS and trust an explicitly configured
reverse proxy. The plugin independently rejects non-loopback HTTP endpoints.

## The plugin entry point is a composition root

The Obsidian `Plugin` subclass owns framework lifecycle hooks, but it does not
own every application rule. It constructs focused services for authentication,
collaboration, vault synchronization, remote events, and settings.

Dependencies are passed through constructors. This keeps each class's inputs
visible, prevents circular access to the complete plugin object, and makes new
features easier to place in the correct domain folder.

Pure, stateless Yjs protocol operations remain functions. Object-oriented
boundaries are used for components that own state or lifecycle, not as a rule
that every function must become a class.

## Database setup is separate from server startup

Starting the backend must not create or seed persistent user data. Database provisioning is an explicit operation:

```bash
npm run db:setup
```

The server opens only an existing, initialized database. This makes missing deployment state visible immediately and prevents an accidental startup from creating default accounts in a new SQLite file.

## Private and network documents are separate for user sessions

The editor document is restored from IndexedDB when a note opens. Attaching that same document to a WebSocket provider would make its complete local history available during synchronization, including updates that must remain private.

User sessions therefore maintain two documents:

```text
private ydoc   editor state and IndexedDB persistence
networkDoc     shared state received through WebSocket
```

Server updates flow from `networkDoc` to the private document. Private updates do not flow in the opposite direction.

Admin sessions use one document because their changes are publishable by definition.

## IndexedDB ownership is encoded in the namespace

A note path alone does not identify who owns an offline history. Reusing one database across account roles allows a later admin session to restore private updates created by a user session.

The current naming scheme separates publishable and private histories:

```text
your-mon:v2:global
your-mon:v2:private:<email>
```

## Access control is enforced at the backend boundary

Client-side behavior reduces accidental publication but cannot provide authorization. Both HTTP file mutations and Yjs document updates are checked against the authenticated backend user.

The `/system` channel is also receive-only. Clients receive shared-vault events through this channel but cannot use it to submit mutations.

## Shared Markdown and Yjs state are stored together

Markdown remains the canonical file format exposed by the shared vault. Persisted Yjs state retains the operation history required for correct CRDT synchronization after a restart. Deleting or renaming a shared path must update both representations.
