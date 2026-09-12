import "./env.ts";
import { ExpressServer } from "./Server/ExpressServer/ExpressServer.ts";
import { WebSocketServer } from "./Server/WebSocketServer.ts";
import { DBServices } from "./users/DBServices.ts";
import { TokenService } from "./auth/TokenService.ts";
import { systemPaths } from "./paths.ts";
import { AuthService } from "./auth/authService.ts";
import { FileManager } from "./Server/FileManager.ts";
import { openUserDatabase } from "./users/databaseLifecycle.ts";
import { loadServerConfig } from "./serverConfig.ts";
import { YjsCollaborationServer } from "./yjs/YjsCollaborationServer.ts";
import { KeyedLock } from "./queue/KeyedLock.ts";
import { Gene } from "./Server/Gene.ts";

/**
 * Backend entry point. Loads configuration and shared services (database,
 * auth, tokens, file management, Yjs collaboration), then wires them into
 * the HTTP (Express) and WebSocket servers and starts both.
 *
 * @throws {Error} If configuration loading or any service/server
 * initialization fails.
 */

const main = () => {
  const config = loadServerConfig();
  const userDB = openUserDatabase(systemPaths.usersDatabase);

  const fileManager = new FileManager();

  const dbService = new DBServices(userDB);

  const tokenService = new TokenService({
    secret: config.tokenSecret,
    dbService,
  });

  const authService = new AuthService(userDB, dbService, tokenService);
  const collaborationServer = new YjsCollaborationServer();
  const keyedLock = new KeyedLock();

  const server = new ExpressServer({
    port: config.port,
    host: config.host,
    requireTls: config.requireTls,
    trustProxy: config.trustProxy,
    fileManager,
    tokenService,
    dbService,
    authService,
    collaborationServer,
    keyedLock,
  });
  server.serverStart();
  const vaultGene = new Gene(systemPaths.vaultGene);
  vaultGene.mutateVaultGene();
  const webSocketServer = new WebSocketServer(
    server.getHttpServer,
    tokenService,
    config.requireTls,
    config.trustProxy,
    collaborationServer,
  );
  webSocketServer.initializeWebSockets();
};

/**
 * Runs main.ts and, if startup fails, logs the error and sets a
 * non-zero exit code instead of letting the process crash with a stack
 * trace.
 */
try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
