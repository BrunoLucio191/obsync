# ObSync developer documentation

These pages are for developers who are new to the codebase and need to change
it safely. Concept pages explain how the system behaves and why; reference
pages list the classes, endpoints and protocols that implement it.

## Suggested reading order

1. [System overview](overview.md): the parts, the two roles, and three
   end-to-end flows. Start here.
2. [Architecture](architecture.md): every module, what it owns, and the
   conventions used across the code.
3. [File synchronization](file-sync.md) and [Collaboration](collaboration.md):
   the two sync mechanisms.
4. [Concurrency and ordering](concurrency.md): the queues that keep operation
   order predictable.
5. [Common changes](common-changes.md): where to edit for typical tasks.

Before changing a boundary, read [Design decisions](decisions.md). Before
debugging something that looks wrong, check [Known issues](known-issues.md).

## Concepts

| Page | Covers |
| --- | --- |
| [System overview](overview.md) | Roles, components, sign-in, typing, and file-operation flows |
| [Architecture](architecture.md) | Module map for backend and plugin, composition roots, channels |
| [File synchronization](file-sync.md) | Vault gene, initial download, publishing, `/system`, three-way merge |
| [Collaboration](collaboration.md) | Yjs rooms on client and server, write check, awareness, persistence |
| [Concurrency and ordering](concurrency.md) | Promise chains, `KeyedLock`, `Queue`, the room message queue |
| [Authorization](permissions.md) | Capabilities per role and every enforcement point |
| [Security](security.md) | Sessions, tokens, WebSocket tickets, TLS deployment, rate limits |
| [Storage](storage.md) | Every file and database on the backend and the client |
| [Design decisions](decisions.md) | Why the current boundaries exist and what they cost |
| [Glossary](glossary.md) | Project-specific terms |

## Working on the code

- [Getting started](../README.md#getting-started): run everything locally
- [Common changes](common-changes.md): where to edit
- [Troubleshooting](debugging.md): startup, connection and sync problems
- [Known issues](known-issues.md): verified bugs and open questions

## API reference

- [Reference index](reference/README.md)
- Plugin: [ObSync](reference/plugin/ObSync.md),
  [authentication](reference/plugin/authentication.md),
  [collaboration](reference/plugin/collaboration.md),
  [synchronization](reference/plugin/synchronization.md),
  [settings](reference/plugin/settings.md),
  [i18n](reference/plugin/i18n.md),
  [types](reference/plugin/types.md)
- Backend: [authentication](reference/backend/authentication.md),
  [services](reference/backend/services.md),
  [HTTP API](reference/backend/http.md),
  [WebSocket API](reference/backend/websocket.md),
  [types](reference/backend/types.md)
