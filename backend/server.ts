import "./env.ts";
import { ExpressServer } from "./Classes/ExpressServer.ts";
import { WebSHocket } from "./Classes/WebSocketServer.ts";
import { DBServices } from "./users/DBServices.ts";
import { TokenService } from "./auth/TokenService.ts";
import { systemPaths } from "./paths.ts";
import { AuthService } from "./auth/authService.ts";
import { FileManager } from "./Classes/FileManager.ts";
import { openUserDatabase } from "./users/databaseLifecycle.ts";
import { loadServerConfig } from "./serverConfig.ts";

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

  const server = new ExpressServer({
    port: config.port,
    host: config.host,
    requireTls: config.requireTls,
    trustProxy: config.trustProxy,
    fileManager,
    tokenService,
    dbService,
    authService,
  });
  server.serverStart();

  const setWebSocket = new WebSHocket(
    server.getHttpServer,
    tokenService,
    config.requireTls,
    config.trustProxy,
  );
  setWebSocket.initializeWebSockets();
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
