# Visão geral

O ObiSync sincroniza notas Markdown entre clientes do Obsidian. Ele combina uma API HTTP para arquivos, WebSocket para eventos em tempo real e Yjs para colaboração no editor.

## Componentes

```text
Obsidian + plugin
       |
       | HTTP e WebSocket
       v
Backend Node.js
       |
       +--> vault global Markdown
       +--> estados Yjs globais
       +--> banco de usuários
```

## Regra central

```text
Admin: alterações podem virar conteúdo global.
User: alterações permanecem locais neste dispositivo.
```

Um usuário comum ainda pode receber alterações do servidor. O que ele não pode fazer é publicar suas próprias alterações.

