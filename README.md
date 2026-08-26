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
- [Getting started](#getting-started)
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

## Getting started

These steps take a fresh clone to a signed-in plugin talking to your own
backend. Run them from the repository root unless noted otherwise.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the backend

Generate a signing secret — this is a random value, not a password you choose:

```bash
openssl rand -base64 48
```

Create `backend/.env`:

```dotenv
OBSYNC_TOKEN_SECRET=<paste the value generated above>
PORT=3000
OBSYNC_HOST=127.0.0.1
OBSYNC_REQUIRE_TLS=false
OBSYNC_TRUST_PROXY=false
```

This configuration is for local development only. For a real deployment, see
[Security: transport rules](docs/security.md#transport-rules) before exposing
the backend beyond your own machine.

### 3. Create and seed the user database

```bash
npm run db:setup
```

This is explicit and runs only once: it refuses to touch an existing
`backend/data/users.sqlite`, and the backend refuses to start against a
missing or invalid one. It prints one line per seeded account with a random
temporary password, for example:

```text
[Database] Seed: initial accounts created.
[Database]   thiago@gmail.com — temporary password (admin): Ax7f...
[Database]   brunoestudos6@gmail.com — temporary password (user): Qm2k...
[Database] Save these passwords now: they will not be shown again.
```

**Copy the admin account's temporary password now** — you'll use it in step 6,
and the terminal is the only place it's ever shown. See
[Security: account passwords](docs/security.md#account-passwords) for the
seeded account list and how to rotate these later.

### 4. Start the backend

```bash
npm run dev --workspace=backend
```

Leave this running; it must stay up while you use the plugin. It logs
`Server running on http://127.0.0.1:3000` once ready.

### 5. Build and install the plugin

```bash
npm run build --workspace=plugin/obSync
```

Copy `plugin/obSync/main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/obSync/` in the Obsidian vault you want to test
with, then in Obsidian: enable **Community plugins** if you haven't already,
and turn on **ObSync** in the plugin list.

### 6. Connect and sign in

Open **Settings → ObSync**. Since no account is connected yet, only the
**Backend server URL** field is shown. Enter `http://127.0.0.1:3000` (use
`127.0.0.1`, not `localhost` — see
[Troubleshooting](docs/debugging.md#plugin-cant-reach-a-local-backend) if
you're curious why) and save it. A **Sign in** button appears; use the admin
e-mail and the temporary password from step 3.

### 7. Change the temporary password

Go to **Settings → ObSync → Account → Change password** and set a real
password immediately — the temporary one only ever appeared once, in your
terminal.

### 8. Next steps

- As admin, add more accounts under **Settings → ObSync → User management**
  (shown in Portuguese as "Administração de usuários" if Obsidian is set to
  that language) — each person installs the same plugin build and connects
  to the same backend URL, then signs in with their own account.
- Only `admin` accounts publish edits to the shared vault; `user` accounts
  edit locally and receive shared changes. See
  [How synchronization works](#how-synchronization-works).
- Want to reach the backend from outside your own machine? The backend URL
  field takes any custom domain, not just `127.0.0.1` — put a TLS reverse
  proxy in front of it and point the field at that proxy's HTTPS URL. See
  [Security: transport rules](docs/security.md#transport-rules).

## Development

Once you're set up, iterate with watch mode instead of rebuilding by hand.

Start the backend in watch mode:

```bash
npm run dev --workspace=backend
```

Run the plugin compiler in watch mode:

```bash
npm run dev --workspace=plugin/obSync
```

`plugin/obSync/main.js` is rewritten on every source change; reload the
plugin in Obsidian (or use a hot-reload plugin) to pick it up.

---

<div align="center">

Made for a self-hosted, private Obsidian vault.

</div>
