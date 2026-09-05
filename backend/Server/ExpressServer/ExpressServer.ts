import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { type Server } from "node:http";
import { createServer } from "node:http";
import { LoginRateLimiter } from "../../auth/LoginRateLimiter.ts";
import type { YjsCollaborationServer as YjsCollaborationGateway } from "../../yjs/YjsCollaborationServer.ts";
import { FileManager } from "../FileManager.ts";
import { AuthService } from "../../auth/authService.ts";
import type { TokenService } from "../../auth/TokenService.ts";
import type { DBServices } from "../../users/DBServices.ts";
import { QueueManager } from "../../queue/QueueManager.ts";
import { RouteAuth } from "./routes/route.auth.ts";
import { RouteUsers } from "./routes/route.users.ts";
import { RouteSyncFiles } from "./routes/route.syncFiles.ts";

/** Constructor options for {@link ExpressServer}. */
type ExpressServerConstructorOptions = {
  port: number;
  host: string;
  /** When `true`, rejects any non-HTTPS request instead of terminating TLS itself (expects a trusted TLS-terminating proxy in front). */
  requireTls: boolean;
  /** When `true`, trusts `X-Forwarded-*` headers from upstream proxies (e.g. for detecting HTTPS and client IP). */
  trustProxy: boolean;
  fileManager: FileManager;
  tokenService: TokenService;
  dbService: DBServices;
  authService: AuthService;
  collaborationServer: YjsCollaborationGateway;
  queueManager: QueueManager;
};

/**
 * The application's HTTP API. Wraps an Express app plus the raw Node HTTP server it listens
 * on (the latter is also used by {@link WebSocketServer} to handle `upgrade` requests).
 * Route handlers themselves live in {@link RouteAuth}, {@link RouteUsers}, and
 * {@link RouteSyncFiles}; this class only wires them up and owns the health check.
 */
export class ExpressServer {
  private readonly app: Express;
  private readonly port: number;
  private readonly host: string;
  private readonly requireTls: boolean;
  private readonly server: Server;
  private readonly fileManager: FileManager;
  private readonly dbService: DBServices;
  private readonly tokenService: TokenService;
  private readonly authService: AuthService;
  private readonly collaborationServer: YjsCollaborationGateway;
  private routeAuth: RouteAuth;
  private routeUsers: RouteUsers;
  private routeSyncFiles: RouteSyncFiles;

  /**
   * Creates the Express app and underlying HTTP server, then wires up middleware and routes.
   * Does not start listening — call {@link serverStart} for that.
   * @param options - Server configuration and the collaborator services used by its routes.
   */
  constructor({
    port,
    host,
    requireTls,
    trustProxy,
    fileManager,
    tokenService,
    dbService,
    authService,
    collaborationServer,
  }: ExpressServerConstructorOptions) {
    this.port = port;
    this.host = host;
    this.requireTls = requireTls;
    this.app = express();
    this.app.set("trust proxy", trustProxy);
    this.server = createServer(this.app);
    this.fileManager = fileManager;
    this.tokenService = tokenService;
    this.dbService = dbService;
    this.authService = authService;
    this.collaborationServer = collaborationServer;
    this.routeUsers = new RouteUsers({
      tokenService: this.tokenService,
      dbService: this.dbService,
      queueManager: new QueueManager(),
    });
    this.routeAuth = new RouteAuth({
      accountLoginRateLimiter: new LoginRateLimiter({
        maxFailedAttempts: 5,
      }),
      ipLoginRateLimiter: new LoginRateLimiter({
        maxFailedAttempts: 25,
      }),
      passwordChangeRateLimiter: new LoginRateLimiter({
        maxFailedAttempts: 5,
      }),
      tokenService: this.tokenService,
      authService: this.authService,
      dbService: this.dbService,
    });
    this.routeSyncFiles = new RouteSyncFiles({
      tokenService: this.tokenService,
      fileManager: this.fileManager,
      collaborationServer: this.collaborationServer,
      queueManager: new QueueManager(),
    });
    this.initializeMiddleware();
    this.initializeRoutes();
  }

  /**
   * Registers global middleware (TLS enforcement, JSON body parsing at a 16mb limit, no-store
   * caching for `/api/auth` responses) and mounts each router at its `/api/*` prefix.
   */
  public initializeMiddleware(): void {
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (this.requireTls && !req.secure) {
        res.status(426).json({ error: "This installation requires an HTTPS connection." });
        return;
      }
      next();
    });
    this.app.use(express.json({ type: "application/json", limit: "16mb" }));

    this.app.use("/api/auth", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    this.app.use("/api/auth", this.routeAuth.router);
    this.app.use("/api/users", this.routeUsers.router);
    this.app.use("/api/sync", this.routeSyncFiles.router);
  }

  /**
   * Registers each router's routes (`/api/auth/*`, `/api/users/*`, `/api/sync/*`) and the
   * unauthenticated health check.
   */
  private initializeRoutes(): void {
    this.routeAuth.startRoute();
    this.routeUsers.startRoute();
    this.routeSyncFiles.startRoute();

    this.app.get("/api/serverHealth", (_req: Request, res: Response) => {
      res.json({ status: "ok", service: "obsync" });
    });
  }

  /**
   * Starts the HTTP server listening for connections.
   * @param port - Port to listen on; defaults to the port passed to the constructor.
   */
  public serverStart(port = this.port): void {
    this.server.once("error", (error) => {
      console.error(`Could not start the server on port ${port}:`, error);
    });
    this.server.listen(port, this.host, () => {
      if (this.requireTls) {
        console.log(`Server running behind a trusted TLS proxy on ${this.host}:${port}`);
        return;
      }
      console.log(`Server running on http://${this.host}:${port}`);
    });
  }

  /** The underlying Node HTTP server, exposed so other components (e.g. the WebSocket server) can attach to its `upgrade` event. */
  get getHttpServer(): Server {
    return this.server;
  }
}
