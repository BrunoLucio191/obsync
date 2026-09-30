# Design decisions

Each section records a decision, the reason for it, and the cost that was
accepted. Read this before changing one of these boundaries: most of them look
like over-engineering until you hit the problem they prevent.

## The backend is the source of truth

The backend owns the canonical vault. Clients report what happened locally;
the backend decides whether it is allowed and what the result is. The plugin
duplicates some checks to avoid pointless requests, but every rule that
protects shared state is enforced on the backend with the role reloaded from
SQLite. A modified plugin can make its own vault inconsistent, but it cannot
change anyone else's.

## Two sync mechanisms instead of one

Whole files (structure, binaries, notes nobody has open) move over plain HTTP
plus `/system` broadcasts. Only the note open in the editor uses Yjs. Running
Yjs for every file in the vault would mean a live document and a socket per
file; whole-file sync is simpler and enough when nobody is typing in the file.
The cost is that the two paths must be kept consistent (for example, a delete
must also remove the `.yjs-state`).

## Operation order is made predictable with queues

Operations are serialized per client and locked per resource
([Concurrency](concurrency.md)). The goal is that the order of operations is
predictable everywhere, not to patch individual races as they are found. The
cost is throughput: one client's requests never run in parallel, even when
they touch unrelated files.

## Sessions use short access tokens and rotating refresh tokens

Access tokens last 15 minutes and are checked against a live session on every
use; refresh tokens rotate on every renewal and are stored only as HMAC
hashes. Logout and revocation are immediate, and a leaked refresh token stops
working as soon as the legitimate client refreshes.

Sessions are kept in memory, so restarting the backend signs everyone out. A
persistent session store can replace the map if uninterrupted sessions across
deployments become necessary.

## WebSockets use one-use tickets

The browser WebSocket API cannot send an `Authorization` header, and a token in
the URL would end up in access logs. The client trades its access token for a
30-second, single-use, channel-scoped ticket and sends it as a subprotocol.
The cost is one extra HTTP round trip per connection.

## TLS terminates at a reverse proxy

The Node process never handles certificates. Loopback-only development uses
plain HTTP; anything else must set `OBSYNC_REQUIRE_TLS=true` and sit behind a
proxy it explicitly trusts. The plugin refuses non-loopback HTTP on its own,
so a misconfigured server cannot silently receive tokens in clear text.

## Database setup is separate from server startup

The server only opens an existing, valid database. Creating and seeding it is
`npm run db:setup`. A missing database is a loud startup error instead of a
silently created empty one with default accounts.

## Regular users keep a private document and a network document

The editor's document is restored from IndexedDB. If the same document were
attached to the WebSocket provider, the sync would send the user's whole local
history to the server. Regular users therefore have two documents, and updates
flow only from the network document into the private one. Admins use one
document because their edits are meant to be published.

## IndexedDB ownership is part of the database name

A note path alone does not say whose history a cache holds. The namespace
(`obsync:v3:global` or `obsync:v3:private:<email>`) does, so an admin session
never restores a user's private history on a shared Obsidian profile.

## Collaboration state is stored as binary Yjs state next to the Markdown

Markdown is the readable format of the vault. The binary state keeps the
identity of every Yjs operation, without which clients reconnecting with a
cached document would duplicate text. Every delete and rename must update both.

## The initial download is skipped when the vault gene matches

Downloading the entire vault on each launch would be slow for large vaults.
The gene (`gene.json`) changes whenever anything in `data/vault/` changes; if
the client's saved gene matches, the server answers `204`. The gene is
compared as a whole, so any change anywhere triggers a full download; there is
no incremental sync.

## Regular users get server versions through a three-way merge

A regular user's local edits never reach the server, so blindly writing server
versions would destroy them. The plugin keeps the last server version of each
file as a merge base and merges with `node-diff3`. Binaries cannot be merged;
a conflicting server version is saved as a copy.

## Unzipping runs in a Web Worker compiled into the bundle

Unzipping a large vault on the main thread would freeze Obsidian. The Worker
code is bundled into a string at build time because Obsidian loads a single
`main.js` and offers no reliable path for a separate Worker file.

## The plugin entry point is a composition root

`ObSync` owns Obsidian's lifecycle hooks and builds focused services; it does
not contain business rules. Dependencies are passed through constructors, which
keeps each class's inputs visible and avoids passing the whole plugin around.
The settings UI depends on the `SettingsController` interface, not on `ObSync`.

## `/system` is receive-only

Clients get vault events on `/system` but must use authenticated,
role-checked HTTP routes to change anything. A message sent on `/system` closes
the socket.
