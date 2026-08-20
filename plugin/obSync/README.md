# ObiSync Obsidian plugin

This workspace contains the Obsidian client for ObiSync. The plugin connects the editor to the ObiSync backend, manages authentication and presence, and applies role-specific synchronization rules.

Project documentation is maintained in the repository root:

- [Project overview](../../README.md)
- [Architecture](../../docs/architecture.md)
- [Collaboration model](../../docs/collaboration.md)
- [Authorization model](../../docs/permissions.md)

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

The build writes `plugin/obSync/main.js`.

## Manual installation

Copy the following files to `<vault>/.obsidian/plugins/obSync/`:

```text
main.js
manifest.json
styles.css
```

Enable ObiSync in Obsidian's community plugin settings or reload the plugin after replacing an existing build.
