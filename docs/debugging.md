# Depuração

## Verificar a conta ativa

Confirme no painel de configurações se a conta logada possui o papel esperado. O backend usa o token autenticado para decidir se aceita escrita global.

## Verificar se o bundle correto está instalado

Depois de alterar o plugin, compile:

```bash
npm run build --workspace=obSync
```

Em seguida, confirme que o `main.js` compilado foi copiado para a pasta do plugin carregado pelo vault. Reinicie ou recarregue o plugin no Obsidian.

## Cenário de teste de permissão

```text
1. Admin abre uma nota e escreve "ADMIN".
2. User abre a mesma nota e escreve "LOCAL".
3. Feche e abra novamente o Obsidian do user.
4. Abra a nota como admin.
5. O admin deve ver apenas o conteúdo global, sem "LOCAL".
6. O user deve continuar vendo sua alteração local neste dispositivo.
```

## Logs úteis

No backend, um update Yjs recusado gera um aviso semelhante a:

```text
[Audit] Update Yjs global bloqueado
```

Se um user conseguir publicar conteúdo, verifique primeiro:

1. se o Obsidian está usando o `main.js` novo;
2. se a conta do cliente realmente possui `role: "user"`;
3. se o backend em execução é o código atualizado;
4. se o conteúdo não havia sido publicado anteriormente por uma sessão admin.

