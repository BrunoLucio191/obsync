# Arquitetura

## Plugin

| Arquivo | Responsabilidade |
| --- | --- |
| `plugin/obSync/src/main.ts` | Inicialização, login, eventos do Obsidian e entrada/saída de salas. |
| `plugin/obSync/src/collab/collab.ts` | Salas Yjs, WebSocket, presença e isolamento entre admin/user. |
| `plugin/obSync/src/offlinePersistence.ts` | Persistência do Yjs no IndexedDB. |
| `plugin/obSync/src/sync/SyncVaultChanges.ts` | Publicação de mudanças estruturais do vault por admins. |
| `plugin/obSync/src/sync/SyncInitialVault.ts` | Download inicial do vault do servidor. |
| `plugin/obSync/src/settings.ts` | Tela de configurações e administração de contas. |

## Backend

| Arquivo | Responsabilidade |
| --- | --- |
| `backend/server.ts` | Cria e inicia API, autenticação e WebSockets. |
| `backend/Classes/ExpressServer.ts` | Rotas HTTP de autenticação, usuários e sincronização de arquivos. |
| `backend/Classes/WebSocketServer.ts` | Autentica upgrades WebSocket e abre os canais. |
| `backend/yjsUtils.ts` | Protocolo Yjs, salas, autorização de updates e presença. |
| `backend/Classes/YjsPersistence.ts` | Salva o estado Yjs global em disco. |
| `backend/Classes/FileManager.ts` | Lê e altera arquivos do vault global. |

## Canais

```text
HTTP /auth e /api     login, usuários e download inicial
HTTP /sync            mudanças globais de arquivos; somente admin
WebSocket /system     eventos de arquivos do servidor para clientes
WebSocket /<nota>     colaboração Yjs da nota
```

