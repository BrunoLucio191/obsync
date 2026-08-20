# ObiSync Obsidian plugin

This workspace contains the Obsidian client for ObiSync. The plugin connects the editor to the ObiSync backend, manages authentication and presence, and applies role-specific synchronization rules.

Project documentation is maintained in the repository root:

- [Project overview](../../README.md)
- [Architecture](../../docs/architecture.md)
- [Collaboration model](../../docs/collaboration.md)
- [Authorization model](../../docs/permissions.md)
- [Security and deployment](../../docs/security.md)
- [Plugin API reference](../../docs/reference/plugin/README.md)

## Development

From the repository root:

```bash
npm install
npm run dev --workspace=obSync
```

Create a production bundle with:

```bash
npm run build --workspace=obSync
```

For a remote backend, provide its public HTTPS URL at build time:

```bash
OBISYNC_API_BASE_URL=https://sync.example.com \
  npm run build --workspace=obSync
```

Non-loopback HTTP endpoints are rejected. The corresponding WebSocket endpoint
is derived automatically and uses WSS.

The build writes `plugin/obSync/main.js`.

## Manual installation

Copy the following files to `<vault>/.obsidian/plugins/obSync/`:

```text
main.js
manifest.json
styles.css
```

Enable ObiSync in Obsidian's community plugin settings or reload the plugin after replacing an existing build.
