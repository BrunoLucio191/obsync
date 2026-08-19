# Persistência

## Servidor

| Dado | Local |
| --- | --- |
| Usuários e papéis | `backend/data/users.sqlite` |
| Vault global Markdown | `backend/data/vault/` |
| Estado Yjs global | `backend/data/yjs-state/` |

O estado Yjs global é persistido para que a colaboração continue após reiniciar o backend.

## Cliente

O plugin usa IndexedDB. Cada nota possui um banco de dados de colaboração.

```text
Admin: your-mon:v2:global:<caminho-da-nota>
User:  your-mon:v2:private:<email>:<caminho-da-nota>
```

Separar a chave por papel e e-mail impede que uma sessão de administrador abra o cache privado de outro usuário e o publique no servidor.

## Cache legado

Versões antigas usavam uma chave compartilhada:

```text
your-mon:<caminho-da-nota>
```

Para preservar edições locais existentes, o usuário comum importa esse estado para seu cache privado. Administradores não usam esse cache legado.

