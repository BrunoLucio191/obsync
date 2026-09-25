// Vault gene on initSync: the plugin sends the gene saved in secretStorage, the server answers
// 204 when it matches its gene, otherwise the zip plus the current gene, which the plugin saves
// only after every file is written. Uses the real ZipWorkerSon with a fake Worker.
import fs from "node:fs/promises";
import { bundlePlugin, captureLogs, fakeObsidian } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
const { notices } = await fakeObsidian();
const server = await startBackend();
await fs.writeFile(`${server.data.paths.vault}/note.md`, "hello");
const { token } = await server.createUser(0);
const plugin = await bundlePlugin({
  ZipWorkerSon: "Workers/zipWorker/ZipWorkerSon.ts",
  configureApiEndpoint: "config/ApiConfig.ts",
  initI18n: "i18n/i18n.ts",
});
plugin.initI18n();
plugin.configureApiEndpoint(server.baseUrl);
const checks = createChecks("gene", logs.out);

let workers = 0;
(globalThis as any).Worker = class {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    workers++;
  }
  postMessage() {
    setTimeout(() =>
      this.onmessage?.({
        data: {
          status: "success",
          entries: [
            { path: "folder", isDir: true },
            { path: "folder/a.md", isDir: false, content: new ArrayBuffer(3), ext: "md" },
          ],
        },
      }),
    );
  }
  terminate() {}
};

/** Obsidian's SecretStorage, with the same id validation. */
const makeSecrets = () => {
  const secrets = new Map<string, string>();
  return {
    secrets,
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => {
      if (!/^[a-z0-9-]+$/.test(id) || id.length > 64) throw new Error(`invalid secret id: ${id}`);
      secrets.set(id, value);
    },
  };
};
const makeApp = (vaultName: string, secretStorage = makeSecrets(), failWrites = false) => ({
  secretStorage,
  vault: {
    getName: () => vaultName,
    adapter: {
      exists: async () => false,
      mkdir: async () => {},
      writeBinary: async () => {
        if (failWrites) throw new Error("disk full");
      },
    },
  },
  workspace: { onLayoutReady: (cb: () => void) => cb() },
});
const auth = {
  prepareAuthenticatedRequest: async () => true,
  Authheaders: () => ({ Authorization: `Bearer ${token}`, "X-ObSync-Client": "gene-client" }),
  isAdmin: () => true,
};

async function initialSync(app: ReturnType<typeof makeApp>) {
  const noticesBefore = notices.length;
  const workersBefore = workers;
  await new plugin.ZipWorkerSon(app, { mute: () => {} }, auth).startWorking();
  for (let i = 0; i < 100 && notices.length === noticesBefore; i++) await new Promise((r) => setTimeout(r, 10));
  return { notice: notices.slice(noticesBefore).join(" | "), downloaded: workers > workersBefore };
}
const gene = (generation: number) => ({
  generation,
  bytes: 5,
  filesCount: 1,
  lastModification: `2026-01-01T00:00:0${generation}.000Z`,
});
const writeGene = (generation: number, pretty = false) =>
  fs.writeFile(server.data.paths.vaultGene, JSON.stringify(gene(generation), null, pretty ? 2 : undefined));
const storage = makeSecrets();
const ID = "obsync-vault-gene-test-vault";

await writeGene(5, true);
let r = await initialSync(makeApp("Test Vault", storage));
await checks.check("sem gene salvo: baixa o zip e salva o gene do servidor em uma linha", () => {
  if (!r.downloaded || r.notice !== "Initial synchronization complete.") throw new Error(JSON.stringify(r));
  if (storage.getSecret(ID) !== JSON.stringify(gene(5))) throw new Error(`salvo: ${storage.getSecret(ID)}`);
});
r = await initialSync(makeApp("Test Vault", storage));
await checks.check("gene igual: 204, nao baixa nada e avisa que esta atualizado", () => {
  if (r.downloaded || r.notice !== "The vault is already up to date.") throw new Error(JSON.stringify(r));
});
await writeGene(6);
r = await initialSync(makeApp("Test Vault", storage));
await checks.check("gene mudou: baixa de novo e salva o novo", () => {
  if (!r.downloaded || storage.getSecret(ID) !== JSON.stringify(gene(6))) throw new Error(JSON.stringify(r));
});
await writeGene(7);
await initialSync(makeApp("Test Vault", storage, true));
await checks.check("falha ao gravar arquivos: gene nao e atualizado", () => {
  if (storage.getSecret(ID) !== JSON.stringify(gene(6))) throw new Error(`salvo: ${storage.getSecret(ID)}`);
});
await fs.rm(server.data.paths.vaultGene);
const noGeneA = await initialSync(makeApp("Test Vault", storage));
const noGeneB = await initialSync(makeApp("Test Vault", storage));
await checks.check("sem gene.json no servidor: sempre baixa", () => {
  if (!noGeneA.downloaded || !noGeneB.downloaded) throw new Error("pulou o download");
});
await writeGene(7);
r = await initialSync(makeApp("Other Vault", storage));
await checks.check("outro vault com o mesmo secretStorage nao reaproveita o gene", () => {
  if (!r.downloaded) throw new Error("pulou o download");
});
for (const name of ["Diário Pessoal", "日記", "a".repeat(120), "My.Vault (2)"]) {
  const secrets = makeSecrets();
  await initialSync(makeApp(name, secrets));
  await checks.check(`id de segredo valido para "${name.slice(0, 16)}"`, () => {
    if (secrets.secrets.size !== 1) throw new Error("gene nao foi salvo");
  });
}

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
