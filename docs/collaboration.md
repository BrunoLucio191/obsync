# Colaboração e Yjs

Yjs é a estrutura que representa o texto colaborativo. Cada nota aberta possui um `Y.Doc` e um texto chamado `codemirror`.

```ts
const ydoc = new Y.Doc();
const ytext = ydoc.getText('codemirror');
```

## Fluxo do administrador

O administrador usa o mesmo documento para editor, persistência local e WebSocket.

```text
Editor <-> ydoc global <-> WebSocket <-> servidor <-> outros clientes
```

As alterações feitas no editor entram no `ydoc`, e o provider WebSocket pode enviá-las ao servidor.

## Fluxo do usuário comum

O usuário comum possui dois documentos.

```text
Servidor -> networkDoc -> ydoc privado -> Editor
Editor -> ydoc privado -> IndexedDB local
```

O código que escolhe o documento de rede é:

```ts
const networkDoc =
	user.role === 'user'
		? new Y.Doc()
		: ydoc;
```

Para `user`, `networkDoc` é outro documento vazio conectado ao WebSocket. O `ydoc` privado nunca é conectado à rede. Para `admin`, `networkDoc` e `ydoc` são o mesmo objeto.

Mudanças recebidas do servidor são copiadas em uma única direção:

```ts
const onNetworkUpdate = (update: Uint8Array): void => {
	Y.applyUpdate(ydoc, update, provider);
};
```

Não existe cópia de updates do `ydoc` privado para o `networkDoc`.

## Abrir e fechar uma nota

```text
1. O plugin abre o cache IndexedDB do usuário/nota.
2. Restaura o ydoc privado ou global.
3. Conecta o provider WebSocket.
4. Recebe o estado global da nota.
5. Ao fechar, encerra provider, persistência e documentos Yjs.
```
