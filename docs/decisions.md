# Decisões técnicas

## Separar documento privado e documento de rede para users

### Problema

Um único `Y.Doc` servia para IndexedDB e WebSocket. Ao reabrir a nota, edições locais restauradas podiam ser interpretadas como alterações a sincronizar.

### Decisão

Usuários comuns usam:

```text
ydoc privado: editor + IndexedDB
networkDoc: WebSocket + estado recebido do servidor
```

### Consequência

Users mantêm edições locais entre reinicializações sem transmitir esse histórico ao servidor.

## Separar IndexedDB por papel e identidade

### Problema

O banco offline era compartilhado por caminho de nota. Uma conta admin no mesmo perfil podia herdar o cache privado e publicá-lo.

### Decisão

Usar namespaces separados:

```text
your-mon:v2:global
your-mon:v2:private:<email>
```

### Consequência

O histórico privado de um usuário não é reutilizado por sessões administrativas nem por outro usuário comum.

## Autorizar no servidor

### Decisão

O servidor aceita updates globais Yjs apenas quando o token autenticado pertence a um admin.

### Consequência

Mesmo um cliente alterado manualmente não consegue gravar updates globais usando uma conta `user` válida.

