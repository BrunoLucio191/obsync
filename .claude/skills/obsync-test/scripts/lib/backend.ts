// Starts the backend the way backend/main.ts does, on temp data.
import { backend, useTempData } from "./env.ts";

/**
 * ExpressServer with the real auth middlewares, plus optionally the WebSocketServer (with Yjs
 * persistence) and the Gene watcher. Users are created with `createUser`, which returns a real
 * access token for the Authorization header.
 *
 * The Gene watcher keeps rewriting gene.json while files change, so a process that started it
 * must not delete its temp dir itself: run it in a child process (see server-process.ts).
 */
export async function startBackend({ websockets = false, gene = false } = {}) {
  const data = await useTempData();
  const { UserDB } = await backend("users/UserDB.ts");
  const { DBServices } = await backend("users/DBServices.ts");
  const { TokenService } = await backend("auth/TokenService.ts");
  const { AuthService } = await backend("auth/authService.ts");
  const { ExpressServer } = await backend("Server/ExpressServer/ExpressServer.ts");
  const { FileManager } = await backend("Server/FileManager.ts");
  const { YjsCollaborationServer } = await backend("yjs/YjsCollaborationServer.ts");
  const { KeyedLock } = await backend("queue/KeyedLock.ts");
  const { QueueManager } = await backend("queue/QueueManager.ts");
  const { Gene } = await backend("Server/Gene.ts");

  const userDB = new UserDB(data.paths.usersDatabase);
  await userDB.setup();
  const dbService = new DBServices(userDB);
  const tokenService = new TokenService({ secret: "s".repeat(48), dbService });
  const collaborationServer = new YjsCollaborationServer();
  const keyedLock = new KeyedLock();
  const vaultGene = new Gene(data.paths.vault, data.paths.vaultGene, new QueueManager(keyedLock));
  const server = new ExpressServer({
    port: 0,
    host: "127.0.0.1",
    requireTls: false,
    trustProxy: false,
    fileManager: new FileManager(),
    tokenService,
    dbService,
    authService: new AuthService(userDB, dbService, tokenService),
    collaborationServer,
    keyedLock,
    vaultGene,
  });
  const listening = new Promise((r) => server.getHttpServer.once("listening", r));
  server.serverStart(0);
  await listening;
  const port = (server.getHttpServer.address() as { port: number }).port;

  if (websockets) {
    const { WebSocketServer } = await backend("Server/WebSocketServer.ts");
    new WebSocketServer(server.getHttpServer, tokenService, false, false, collaborationServer).initializeWebSockets();
  }
  if (gene) vaultGene.mutateVaultGene();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    data,
    userDB,
    dbService,
    tokenService,
    /** Creates a user and returns it with a real access token. */
    async createUser(index: number, role: "admin" | "user" = "admin") {
      const created = await dbService.createUser(`User ${index}`, `user${index}@test.dev`, "secret123", role);
      if (!created.ok) throw new Error(`could not create user ${index}: ${created.reason}`);
      const session = tokenService.sessionFor(created.user);
      return { user: session.user, token: session.token as string };
    },
  };
}
