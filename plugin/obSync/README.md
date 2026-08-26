# ObSync Obsidian plugin

This workspace contains the Obsidian client for ObSync. The plugin connects the editor to the ObSync backend, manages authentication and presence, and applies role-specific synchronization rules.

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
npm run dev --workspace=plugin/obSync
```

Create a production bundle with:

```bash
npm run build --workspace=plugin/obSync
```

The backend URL is a runtime setting, not a build-time one: the same build
works for every user, who each enter their own ObSync backend's URL under
**Settings → ObSync → Backend connection** the first time they open the
plugin. Non-loopback HTTP endpoints are rejected there; the corresponding
WebSocket endpoint is derived automatically and uses WSS.

The build writes `plugin/obSync/main.js`.

## Manual installation

Copy the following files to `<vault>/.obsidian/plugins/obSync/`:

```text
main.js
manifest.json
styles.css
```

Enable ObSync in Obsidian's community plugin settings or reload the plugin after replacing an existing build.
