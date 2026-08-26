<div align="center">

# ObSync

**Self-hosted, real-time collaborative Markdown editing for Obsidian.**

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=white)
![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Yjs](https://img.shields.io/badge/CRDT-Yjs-F5A623)

</div>

ObSync pairs an Obsidian plugin with a self-hosted Node.js backend so a vault
can be edited by several people at once, backed by [Yjs](https://yjs.dev) CRDTs
over WebSocket. Each account is assigned one of two roles, and any number of
accounts can hold either role:

- **`admin`** accounts publish changes to the shared vault.
- **`user`** accounts edit locally and receive shared changes, but their
  own edits stay private — never published back to the vault.

## Contents

- [How synchronization works](#how-synchronization-works)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Development](#development)

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
- [API reference](docs/reference/README.md)
  - [Plugin classes and methods](docs/reference/plugin/README.md)
  - [Backend services](docs/reference/backend/README.md)
  - [HTTP API](docs/reference/backend/http.md)
  - [WebSocket API](docs/reference/backend/websocket.md)
- [Concepts and operational guides](docs/README.md#concepts)

## Development

Install workspace dependencies from the repository root:

```bash
npm install
```

Create `backend/.env` with the backend settings:

```dotenv
OBSYNC_TOKEN_SECRET=<output from openssl rand -base64 48>
PORT=3000
OBSYNC_HOST=127.0.0.1
OBSYNC_REQUIRE_TLS=false
OBSYNC_TRUST_PROXY=false
```

Generate the signing secret with:

```bash
openssl rand -base64 48
```

Create the user database and apply the initial seed:

```bash
npm run db:setup
```

Database setup is explicit and runs only once. The command refuses to overwrite an existing `backend/data/users.sqlite` file. Backend startup also refuses to create a missing or invalid database.

Start the backend in watch mode:

```bash
npm run dev --workspace=backend
```

Build the plugin:

```bash
npm run build --workspace=plugin/obSync
```

Remote builds must provide an HTTPS backend URL:

```bash
OBSYNC_API_BASE_URL=https://sync.example.com \
  npm run build --workspace=plugin/obSync
```

Run the plugin compiler in watch mode:

```bash
npm run dev --workspace=plugin/obSync
```

The plugin build produces `plugin/obSync/main.js`. Copy `main.js`, `manifest.json`, and `styles.css` to the plugin directory used by the target Obsidian vault, then reload the plugin in Obsidian.

---

<div align="center">

Made for a self-hosted, private Obsidian vault.

</div>
