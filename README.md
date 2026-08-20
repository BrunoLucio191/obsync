# ObiSync

ObiSync is an Obsidian plugin and Node.js service for collaborative Markdown editing. It supports two account roles with different publishing rights:

- `admin` accounts can publish changes to the shared vault.
- `user` accounts can edit locally and receive shared changes, but cannot publish their private edits.

## How synchronization works

```text
Admin
Editor <-> Yjs document <-> WebSocket <-> server

User
Server -> network document -> private document -> editor
Editor -> private document -> IndexedDB
```

User edits remain in a private Yjs document stored in the local IndexedDB database. A separate network document receives server updates, so private history is never attached to the WebSocket provider. The server independently enforces the same rule and rejects Yjs updates from non-admin accounts.

## Repository layout

```text
backend/         HTTP API, WebSocket server, authentication, and shared storage
plugin/obSync/   Obsidian plugin source and build configuration
docs/            architecture and operational documentation
```

## Documentation

- [Documentation index](docs/README.md)
- [System overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [Collaboration model](docs/collaboration.md)
- [Authorization model](docs/permissions.md)
- [Storage](docs/storage.md)
- [Glossary](docs/glossary.md)
- [Design decisions](docs/decisions.md)
- [Troubleshooting](docs/debugging.md)

## Development

Install workspace dependencies from the repository root:

```bash
npm install
```

Start the backend in watch mode:

```bash
npm run dev --workspace=backend
```

Build the plugin:

```bash
npm run build --workspace=obSync
```

Run the plugin compiler in watch mode:

```bash
npm run dev --workspace=obSync
```

The plugin build produces `plugin/obSync/main.js`. Copy `main.js`, `manifest.json`, and `styles.css` to the plugin directory used by the target Obsidian vault, then reload the plugin in Obsidian.

