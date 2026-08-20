# Glossary

| Term | Definition |
| --- | --- |
| Awareness | Transient Yjs presence state, including user identity and cursor information |
| CRDT | A data structure that merges concurrent changes without a central edit lock |
| IndexedDB | Client-side database used by the plugin to retain Yjs history across restarts |
| Muted path | A path temporarily excluded from vault event publication to prevent feedback loops |
| `networkDoc` | The `Y.Doc` attached to `WebsocketProvider`; separate from the private document for user sessions |
| `originClientId` | Identifier attached to a file event so the originating client does not apply it twice |
| Provider | The `WebsocketProvider` instance responsible for Yjs network synchronization |
| Room | The server and client state associated with one encoded Markdown file path |
| State vector | Compact Yjs summary used to determine which updates another document is missing |
| `Y.Doc` / `ydoc` | Yjs container holding the collaborative state for a note |
| `Y.Text` | Yjs shared text type bound to the CodeMirror editor under the `codemirror` key |

