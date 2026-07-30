import "./env.ts";
import { ExpressServer } from "./Classes/dataBase/serverClass.ts";
import { WebSHocket } from "./Classes/webSocketClass.ts";
export { vaultExitPath, vaultPath } from "./paths.ts";

const main = () => {
  const server = new ExpressServer();
  server.serverStart();
  const setWebSocket = new WebSHocket(server.getHttpServer, server.auth);
  setWebSocket.initializeWebSockets();
};

main();
