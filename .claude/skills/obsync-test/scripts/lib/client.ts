// A plugin client wired the way plugin/obSync/src/main.ts wires it.
import { bundlePlugin, fakeObsidian } from "./env.ts";
import { FakeVault } from "./fake-vault.ts";

let plugin: any;

/** Plugin modules used by the clients, bundled once and configured for `baseUrl`. */
export async function loadPlugin(baseUrl: string) {
  plugin ??= await bundlePlugin({
    SyncVaultChanges: "sync/SyncVaultChanges.ts",
    SystemChannel: "sync/SystemChannel.ts",
    SyncInitialVault: "sync/SyncInitialVault.ts",
    RemoteVaultChangeService: "vault/RemoteVaultChangeService.ts",
    ServerVersionMerger: "vault/ServerVersionMerger.ts",
    SyncBaseStore: "vault/SyncBaseStore.ts",
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
 * One client (admin by default) with its own vault, queue, mute registry and merge bases,
 * shared by SyncVaultChanges, RemoteVaultChangeService and SyncInitialVault, plus a
 * SystemChannel when `websocket` is true. A full sync requested by RemoteVaultChangeService
 * runs right away (main.ts debounces it); `fullSyncs` counts them.
 * @param issueTicket - returns a /system WebSocket ticket for the client's token.
 */
export async function createClient(options: {
  clientId: string;
  token: string;
  websocket: boolean;
  role?: "admin" | "user";
  issueTicket?: () => Promise<string | null>;
}) {
  if (!plugin) throw new Error("call loadPlugin(baseUrl) first");
  const { clientId, token } = options;
  const role = options.role ?? "admin";
  const vault = new FakeVault();
  const secrets = new Map<string, string>();
  const app = {
    vault,
    fileManager: vault.fileManager,
    workspace: { getActiveFile: () => null, onLayoutReady: (cb: () => void) => cb() },
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => secrets.set(id, value),
    },
  };
  const auth = {
    clientId,
    isAdmin: () => role === "admin",
    isReadOnlyUser: () => role === "user",
    isAuthenticated: () => true,
    prepareAuthenticatedRequest: async () => true,
    refreshSession: async () => {},
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-ObSync-Client": clientId,
    }),
    AuthHeaders: () => ({ Authorization: `Bearer ${token}`, "X-ObSync-Client": clientId }),
    GeneHeader: (savedGene: string) => ({ "X-ObSync-Gene": savedGene }),
    createWebSocketTicket: async () => (options.issueTicket ? options.issueTicket() : null),
  };
  const collaboration = {
    currentPath: null as string | null,
    disconnectIfAffected: (_path: string) => {},
    scheduleActiveRoomSync: () => {},
  };
  const mutedPaths = new plugin.PathMuteRegistry();
  const queueManager = new plugin.QueueManager(new plugin.KeyedLock());
  const merger = new plugin.ServerVersionMerger(
    app,
    mutedPaths,
    new plugin.SyncBaseStore(vault.adapter, `${vault.configDir}/plugins/obSync/sync-base`),
  );
  const initialSync = new plugin.SyncInitialVault(app, auth, mutedPaths, queueManager, merger);
  const client = {
    clientId,
    vault,
    auth,
    collaboration,
    fullSyncs: 0,
    initialSync,
    remote: null as any,
    channel: null as any,
  };
  client.remote = new plugin.RemoteVaultChangeService(
    app,
    auth,
    mutedPaths,
    collaboration,
    queueManager,
    merger,
    () => {
      client.fullSyncs++;
      void initialSync.sync();
    },
  );
  const obsidianPlugin = { app, registerEvent: () => {} };
  new plugin.SyncVaultChanges(obsidianPlugin, auth, mutedPaths, collaboration, queueManager).initialize();
  client.channel = options.websocket ? new plugin.SystemChannel(auth, client.remote, app, initialSync) : null;
  return client;
}

export { fakeObsidian };
