// Plugin side of a remote rename: when the note open in the collaboration room is the renamed
// file or lives under the renamed folder, RemoteVaultChangeService asks the controller to
// resync the room, after the local vault already shows the new path. Unrelated renames don't.
import { captureLogs, fakeObsidian } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createClient, loadPlugin } from "../lib/client.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
await fakeObsidian();
const server = await startBackend();
await loadPlugin(server.baseUrl);
const { token } = await server.createUser(0);
const client = await createClient({ clientId: "remote", token, websocket: false });
const checks = createChecks("rename-follow", logs.out);
const { vault, collaboration } = client;

for (const folder of ["pasta", "pasta/sub", "outra", "p", "p-x"]) vault.seed(folder);
vault.seed("pasta/sub/funda.md", "funda");
vault.seed("outra/nota.md", "nota");
vault.seed("p/a.md", "a");
vault.seed("p-x/b.md", "b");

/** Applies a remote rename and returns, per resync request, whether the vault already had the new path. */
async function remoteRename(oldPath: string, newPath: string, isFolder: boolean, current: string | null) {
  collaboration.currentPath = current;
  const calls: { newPathVisible: boolean; oldPathGone: boolean }[] = [];
  collaboration.scheduleActiveRoomSync = () => {
    const target = current ? newPath + current.slice(oldPath.length) : "";
    calls.push({
      newPathVisible: Boolean(vault.getAbstractFileByPath(target)),
      oldPathGone: !vault.getAbstractFileByPath(current ?? ""),
    });
  };
  await client.remote.apply({ type: "rename", oldPath, newPath, isFolder, originClientId: "other" });
  return calls;
}

const folderCalls = await remoteRename("pasta", "pasta2", true, "pasta/sub/funda.md");
await checks.check("pasta renomeada com a nota aberta dentro: pede resync uma vez", () => {
  if (folderCalls.length !== 1) throw new Error(`${folderCalls.length} chamadas`);
});
await checks.check("o resync vem depois do vault local ja ter o caminho novo", () => {
  const [call] = folderCalls;
  if (!call?.newPathVisible || !call.oldPathGone) throw new Error(JSON.stringify(call));
});

const fileCalls = await remoteRename("outra/nota.md", "outra/n2.md", false, "outra/nota.md");
await checks.check("a propria nota aberta renomeada: pede resync", () => {
  if (fileCalls.length !== 1 || !fileCalls[0].newPathVisible) throw new Error(JSON.stringify(fileCalls));
});

const prefixCalls = await remoteRename("p", "q", true, "p-x/b.md");
await checks.check("pasta com prefixo parecido (p vs p-x): nao pede resync", () => {
  if (prefixCalls.length) throw new Error(`${prefixCalls.length} chamadas`);
});

const unrelatedCalls = await remoteRename("q", "r", true, "outra/n2.md");
await checks.check("rename sem relacao com a nota aberta: nao pede resync", () => {
  if (unrelatedCalls.length) throw new Error(`${unrelatedCalls.length} chamadas`);
});

const noRoomCalls = await remoteRename("r", "s", true, null);
await checks.check("sem nota aberta: nao pede resync", () => {
  if (noRoomCalls.length) throw new Error(`${noRoomCalls.length} chamadas`);
});

await checks.check("sem erro no plugin", () => {
  const errors = [...logs.pluginErrors, ...logs.unhandled];
  if (errors.length) throw new Error(errors.slice(0, 3).join(" | "));
});

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
