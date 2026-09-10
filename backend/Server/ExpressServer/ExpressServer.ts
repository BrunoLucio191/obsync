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
import type { KeyedLock } from "../../queue/KeyedLock.ts";
import { RouteAuth } from "./routes/route.auth.ts";
import { RouteUsers } from "./routes/route.users.ts";
import { RouteSyncFiles } from "./routes/route.syncFiles.ts";
import { AuthController } from "./routes/controllers/AuthController.ts";
import type { AuthenticatedUser } from "../../auth/auth.types.ts";

type ExpressServerConstructorOptions = {
  port: number;
  host: string;
  requireTls: boolean;
  trustProxy: boolean;
  fileManager: FileManager;
  tokenService: TokenService;
  dbService: DBServices;
  authService: AuthService;
  collaborationServer: YjsCollaborationGateway;
  keyedLock: KeyedLock;
};

/**
 * The application's HTTP API.
 */
export class ExpressServer {
  readonly #app: Express;
  readonly #port: number;
  readonly #host: string;
  readonly #requireTls: boolean;
  readonly #server: Server;
  readonly #fileManager: FileManager;
  readonly #dbService: DBServices;
  readonly #tokenService: TokenService;
  readonly #authService: AuthService;
  readonly #collaborationServer: YjsCollaborationGateway;
  readonly #routeAuth: RouteAuth;
  readonly #routeUsers: RouteUsers;
  readonly #routeSyncFiles: RouteSyncFiles;

  /**
   * Creates the Express app and underlying HTTP server, then set up middleware and routes.
   * Does not start listening, call serverStart} for that.
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
    keyedLock,
  }: ExpressServerConstructorOptions) {
    this.#port = port;
    this.#host = host;
    this.#requireTls = requireTls;
    this.#app = express();
    this.#app.set("trust proxy", trustProxy);
    this.#server = createServer(this.#app);
    this.#fileManager = fileManager;
    this.#tokenService = tokenService;
    this.#dbService = dbService;
    this.#authService = authService;
    this.#collaborationServer = collaborationServer;
    this.#routeUsers = new RouteUsers({
      adminMiddleware: this.#requireAdmin,
      authMiddleware: this.#requireAuth,
      dbService: this.#dbService,
      queueManager: new QueueManager(keyedLock),
    });
    this.#routeAuth = new RouteAuth({
      authMiddleware: this.#requireAuth,
      authService: this.#authService,
      authController: new AuthController({
        dbService: this.#dbService,
        queueManager: new QueueManager(keyedLock),
        authService: this.#authService,
        passwordChangeRateLimiter: new LoginRateLimiter({
          maxFailedAttempts: 5,
        }),
        ipLoginRateLimiter: new LoginRateLimiter({
          maxFailedAttempts: 25,
        }),
        accountLoginRateLimiter: new LoginRateLimiter({
          maxFailedAttempts: 5,
        }),
        tokenService: this.#tokenService,
      }),
    });
    this.#routeSyncFiles = new RouteSyncFiles({
      tokenService: this.#tokenService,
      fileManager: this.#fileManager,
      collaborationServer: this.#collaborationServer,
      queueManager: new QueueManager(keyedLock),
    });
    this.initializeMiddleware();
    this.#initializeRoutes();
  }

  /**
   * Registers global middleware
   */
  public initializeMiddleware(): void {
    this.#app.use((req: Request, res: Response, next: NextFunction) => {
      if (this.#requireTls && !req.secure) {
        res.status(426).json({ error: "This installation requires an HTTPS connection." });
        return;
      }
      next();
    });
    this.#app.use(express.json({ type: "application/json", limit: "25mb" }));

    this.#app.use("/api/auth", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    this.#app.use("/api/auth", this.#routeAuth.router);
    this.#app.use("/api/users", this.#routeUsers.router);
    this.#app.use("/api/sync", this.#routeSyncFiles.router);
  }

  /**
   * Registers each router's routes (`/api/auth/*`, `/api/users/*`, `/api/sync/*`)
   */
  #initializeRoutes(): void {
    this.#routeAuth.startRoute();
    this.#routeUsers.startRoute();
    this.#routeSyncFiles.startRoute();
  }

  /**
   * Starts the HTTP server listening for connections.
   * @param port - Port to listen on; defaults to the port passed to the constructor.
   */
  public serverStart(port = this.#port): void {
    this.#server.once("error", (error) => {
      console.error(`Could not start the server on port ${port}:`, error);
    });

    this.#server.listen(port, this.#host, () => {
      if (this.#requireTls) {
        console.log(`Server running behind a trusted TLS proxy on ${this.#host}:${port}`);
        return;
      }
      console.log(`Server running on http://${this.#host}:${port}`);
    });
  }

  #requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const authenticatedUser = await this.#tokenService.verifyToken(token);

    if (!authenticatedUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.authenticatedUser = authenticatedUser;
    res.locals.accessToken = token;
    next();
  };

  #requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const user = this.#currenteUser(res);
    if (user.role !== "admin") {
      res.status(403).json({ error: "Only Adms can perform this action." });
      return;
    }
    next();
  };
  #currenteUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  /** Node HTTP server, exposed to other components */
  get getHttpServer(): Server {
    return this.#server;
  }
}
