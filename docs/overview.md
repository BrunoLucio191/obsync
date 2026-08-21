# System overview

ObSync synchronizes Markdown notes between Obsidian clients through a Node.js backend. The plugin uses HTTPS for authentication and vault operations, secure WebSocket connections for live events, and Yjs for collaborative text state. Loopback-only development may use HTTP and WebSocket without TLS.

```text
Obsidian client
  |-- HTTPS ------- authentication, users, initial vault download, file operations
  |-- WSS /system - server-to-client vault events
  `-- WSS /<note> - Yjs synchronization and awareness

Node.js backend
  |-- SQLite ------ users and roles
  |-- Markdown ---- shared vault
  `-- Yjs state --- persistent collaborative history
```

## Roles

An `admin` account can modify the shared vault. A `user` account receives shared content but keeps its own edits on the local device.

This restriction is enforced twice:

1. The plugin does not connect a user's private Yjs document to the network.
2. The backend rejects write messages unless the authenticated account is an admin.

Client-side separation prevents accidental publication. Server-side authorization prevents a modified or outdated client from bypassing the policy.

## Continue reading

- [Architecture](architecture.md) for module ownership and dependency direction
- [Plugin API](reference/plugin/README.md) for client classes and methods
- [Backend API](reference/backend/README.md) for services and protocol contracts
