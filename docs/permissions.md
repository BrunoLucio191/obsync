# Permissões

| Ação | Admin | User |
| --- | :---: | :---: |
| Editar texto no editor | Sim | Sim |
| Salvar histórico no IndexedDB local | Sim | Sim |
| Receber mudanças globais | Sim | Sim |
| Enviar update Yjs global | Sim | Não |
| Criar, modificar, renomear ou apagar no servidor | Sim | Não |
| Administrar contas | Sim | Não |

## Defesa no cliente

O cliente usa documentos separados para impedir que o histórico privado seja enviado pelo WebSocket.

## Defesa no servidor

O servidor também valida o papel da conta autenticada antes de aplicar um update Yjs:

```ts
if (!connectionState.canWriteGlobal) {
	return;
}
```

O valor é definido a partir do usuário autenticado:

```ts
canWriteGlobal: authenticatedUser.userRole === 'admin';
```

Essa validação no servidor é obrigatória: regras no cliente não são suficientes para segurança.

