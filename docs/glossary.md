# Glossário

| Termo | Significado |
| --- | --- |
| `Y.Doc` / `ydoc` | Documento Yjs que guarda o estado colaborativo de uma nota. |
| `Y.Text` | Tipo Yjs usado para o texto da nota; neste projeto usa a chave `codemirror`. |
| CRDT | Estrutura de dados que permite combinar alterações de múltiplos clientes. |
| `networkDoc` | Documento conectado ao WebSocket. Para users, é separado do documento privado. |
| Provider | Objeto `WebsocketProvider` que implementa a conexão com o servidor. |
| IndexedDB | Banco local do navegador/Electron usado para persistir o estado offline. |
| Sala | Uma conexão colaborativa associada ao caminho de uma nota. |
| `originClientId` | Identificador do cliente que originou uma mudança de arquivo. |
| Muted path | Caminho temporariamente ignorado para evitar que uma mudança recebida seja republicada. |

