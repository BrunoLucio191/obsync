# ObiSync developer documentation

This documentation is organized as a developer portal. Concept pages explain
why the system behaves as it does. Reference pages describe the classes,
methods, objects, endpoints, and protocols that implement that behavior.

## Start here

| Page | Use it when you need to |
| --- | --- |
| [System overview](overview.md) | Understand the product, roles, and trust boundaries |
| [Architecture](architecture.md) | Find the source module responsible for a behavior |
| [API reference](reference/README.md) | Look up a class, method, object, endpoint, or protocol |
| [Glossary](glossary.md) | Decode project-specific names such as `networkDoc` and muted path |

## Concepts

- [Collaboration model](collaboration.md) — document ownership, Yjs flow, and presence
- [Authorization model](permissions.md) — capabilities and enforcement points
- [Storage](storage.md) — SQLite, Markdown, Yjs state, IndexedDB, and SecretStorage
- [Security](security.md) — sessions, WebSocket tickets, and TLS deployment
- [Design decisions](decisions.md) — reasons behind the current boundaries

## API reference

- [Reference index](reference/README.md)
- [Plugin API](reference/plugin/README.md)
  - [ObSync](reference/plugin/ObSync.md)
  - [AuthService and UserAdminService](reference/plugin/authentication.md)
  - [Collaboration API](reference/plugin/collaboration.md)
  - [Synchronization and vault services](reference/plugin/synchronization.md)
  - [Plugin data types](reference/plugin/types.md)
- [Backend API](reference/backend/README.md)
  - [Authentication services](reference/backend/authentication.md)
  - [Backend services](reference/backend/services.md)
  - [HTTP API](reference/backend/http.md)
  - [WebSocket API](reference/backend/websocket.md)
  - [Backend data types](reference/backend/types.md)

## Operations

- [Troubleshooting](debugging.md) — build, startup, authentication, and synchronization checks
- [Security deployment](security.md#transport-rules) — local and remote transport configuration
- [Database setup](storage.md#sqlite-user-database) — explicit database creation and seed

## Suggested reading paths

New contributors should read the [system overview](overview.md),
[architecture](architecture.md), and [collaboration model](collaboration.md), then
use the [plugin](reference/plugin/README.md) or
[backend](reference/backend/README.md) reference while changing code.

For an authentication change, start with
[AuthService](reference/plugin/authentication.md#authservice), continue with
[TokenService](reference/backend/authentication.md#tokenservice), and finish at
the [HTTP](reference/backend/http.md#authentication) and
[WebSocket](reference/backend/websocket.md#authentication-handshake) contracts.
