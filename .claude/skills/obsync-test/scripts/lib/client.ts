// A plugin client wired the way plugin/obSync/src/main.ts wires it.
import { bundlePlugin, fakeObsidian } from "./env.ts";
import { FakeVault } from "./fake-vault.ts";

let plugin: any;

/** Plugin modules used by the clients, bundled once and configured for `baseUrl`. */
export async function loadPlugin(baseUrl: string) {
  plugin ??= await bundlePlugin({
    SyncVaultChanges: "sync/SyncVaultChanges.ts",
    SystemChannel: "sync/SystemChannel.ts",
    RemoteVaultChangeService: "vault/RemoteVaultChangeService.ts",
    PathMuteRegistry: "vault/PathMuteRegistry.ts",
    QueueManager: "queue/QueueManager.ts",
    KeyedLock: "queue/KeyedLock.ts",
    configureApiEndpoint: "config/ApiConfig.ts",
    initI18n: "i18n/i18n.ts",
  });
  plugin.initI18n();
  plugin.configureApiEndpoint(baseUrl);
  return plugin;
}

/**
 * One admin client: its own vault, queue and mute registry shared by SyncVaultChanges and
 * RemoteVaultChangeService, and a SystemChannel when `websocket` is true.
 * @param issueTicket - returns a /system WebSocket ticket for the client's token.
 */
export async function createClient(options: {
  clientId: string;
  token: string;
  websocket: boolean;
  issueTicket?: () => Promise<string | null>;
}) {
  if (!plugin) throw new Error("call loadPlugin(baseUrl) first");
  const { clientId, token } = options;
  const vault = new FakeVault();
  const auth = {
    clientId,
    isAdmin: () => true,
    isReadOnlyUser: () => false,
    isAuthenticated: () => true,
    prepareAuthenticatedRequest: async () => true,
    refreshSession: async () => {},
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-ObSync-Client": clientId,
    }),
    Authheaders: () => ({ Authorization: `Bearer ${token}`, "X-ObSync-Client": clientId }),
    createWebSocketTicket: async () => (options.issueTicket ? options.issueTicket() : null),
  };
  const collaboration = { currentPath: null, disconnectIfAffected: () => {}, scheduleActiveRoomSync: () => {} };
  const mutedPaths = new plugin.PathMuteRegistry();
  const queueManager = new plugin.QueueManager(new plugin.KeyedLock());
  const remote = new plugin.RemoteVaultChangeService(
    { vault, fileManager: vault.fileManager },
    auth,
    mutedPaths,
    collaboration,
    queueManager,
  );
  const obsidianPlugin = { app: { vault, workspace: { getActiveFile: () => null } }, registerEvent: () => {} };
  new plugin.SyncVaultChanges(obsidianPlugin, auth, mutedPaths, collaboration, queueManager).initialize();
  const channel = options.websocket ? new plugin.SystemChannel(auth, remote) : null;
  return { clientId, vault, channel, remote, auth };
}

export { fakeObsidian };
