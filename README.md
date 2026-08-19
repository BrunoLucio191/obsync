# ObiSync

Plugin para o Obsidian com edição colaborativa de notas Markdown. O projeto possui um plugin cliente e um backend local.

## Regras de colaboração

- Administradores podem criar, editar, renomear e apagar conteúdo global.
- Usuários comuns podem editar suas notas localmente.
- Usuários comuns recebem mudanças publicadas por administradores.
- Alterações privadas de usuários comuns não devem ser enviadas ao servidor.

## Arquitetura resumida

```text
Administrador: editor <-> Yjs global <-> WebSocket <-> servidor

Usuário comum:
servidor -> documento de rede -> documento privado -> editor
editor -> documento privado -> IndexedDB local
```

## Documentação

- [Índice da documentação](docs/README.md)
- [Visão geral](docs/overview.md)
- [Arquitetura](docs/architecture.md)
- [Colaboração e Yjs](docs/collaboration.md)
- [Permissões](docs/permissions.md)
- [Persistência](docs/storage.md)
- [Glossário](docs/glossary.md)
- [Decisões técnicas](docs/decisions.md)
- [Depuração](docs/debugging.md)

## Estrutura do repositório

```text
backend/         API HTTP, WebSocket, autenticação e persistência global
plugin/obSync/   plugin instalado no Obsidian
docs/            documentação técnica do projeto
```

## Desenvolvimento

Instale as dependências na raiz:

```bash
npm install
```

Inicie o backend em modo de desenvolvimento:

```bash
npm run dev --workspace=backend
```

Compile o plugin:

```bash
npm run build --workspace=obSync
```

Para desenvolvimento contínuo do plugin:

```bash
npm run dev --workspace=obSync
```

Após compilar, garanta que `plugin/obSync/main.js`, `manifest.json` e `styles.css` estejam na pasta do plugin do vault que o Obsidian realmente carrega. Reinicie ou recarregue o plugin após trocar o bundle.

