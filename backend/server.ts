import "./env.ts";
import { ExpressServer } from "./Classes/ExpressServer.ts";
import { WebSHocket } from "./Classes/WebSocketServer.ts";
import { UserDB } from "./users/UserDB.ts";
import { DBServices } from "./users/DBServices.ts";
import { TokenService } from "./auth/TokenService.ts";
import { systemPaths } from "./paths.ts";
import { AuthService } from "./auth/authService.ts";
import { FileManager } from "./Classes/FileManager.ts";

const main = () => {
  const userDB = new UserDB(systemPaths.usersDatabase);
  userDB.initialize();

  const fileManager = new FileManager();

  const dbService = new DBServices(userDB);

  const tokenService = new TokenService({
    secret: process.env.OBISYNC_TOKEN_SECRET!,
    dbService,
  });

  const authService = new AuthService(userDB, dbService, tokenService);

  const server = new ExpressServer({
    port: Number(process.env.PORT) ?? 3000,
    fileManager,
    tokenService,
    dbService,
    authService,
  });
  server.serverStart();

  const setWebSocket = new WebSHocket(server.getHttpServer, tokenService);
  setWebSocket.initializeWebSockets();
};

main();
