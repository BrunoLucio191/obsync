import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { type Server } from "node:http";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { systemPaths } from "../../paths.ts";
import type { AuthenticatedUser, UserRole, WebSocketChannel } from "../../auth/auth.types.ts";
import { LoginRateLimiter } from "../../auth/LoginRateLimiter.ts";
import { publishVaultChange } from "../../syncEvents.ts";
import type { YjsCollaborationServer as YjsCollaborationGateway } from "../../yjs/YjsCollaborationServer.ts";
import { FileManager } from "../FileManager.ts";
import { AuthService } from "../../auth/authService.ts";
import type { TokenService } from "../../auth/TokenService.ts";
import type { DBServices } from "../../users/DBServices.ts";
import type { QueueManager } from "../../queue/QueueManager.ts";
import { mutationErrorMessage, mutationErrorStatus } from "./mutationFunctions.ts";
import { RouteAuth } from "./routes/route.auth.ts";

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
 * The application's HTTP API: authentication endpoints, user management endpoints, vault
 * sync endpoints, and a vault-zip download endpoint. Wraps an Express app plus the raw
 * Node HTTP server it listens on (the latter is also used by {@link WebSocketServer} to
 * handle `upgrade` requests).
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
  private readonly queueManager: QueueManager;
  private routeAuth: RouteAuth;

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
    queueManager,
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
    this.queueManager = queueManager;
    this.routeAuth = new RouteAuth(
      new LoginRateLimiter({
        maxFailedAttempts: 5,
      }),
      new LoginRateLimiter({
        maxFailedAttempts: 25,
      }),
      new LoginRateLimiter({
        maxFailedAttempts: 5,
      }),
      this.tokenService,
      this.authService,
      this.dbService,
    );
    this.initializeMiddleware();
    this.initializeRoutes();
  }

  /** Registers global middleware: TLS enforcement, JSON body parsing (16mb limit),
   * and no-store caching for `/auth` responses. */
  public initializeMiddleware(): void {
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (this.requireTls && !req.secure) {
        res.status(426).json({ error: "This installation requires an HTTPS connection." });
        return;
      }
      next();
    });

    this.app.use(express.json({ limit: "16mb" }));

    this.app.use("/auth", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    this.app.use("/auth", this.routeAuth.router);
  }

  /**
   * Registers every HTTP route: health check, auth endpoints (`/auth/*`), admin-only user
   * management endpoints (`/api/users/*`), the vault zip download (`/api/syncfiles`), and the
   * global vault mutation endpoints (`/sync/*`, admin-only). Also defines the `requireAuth` and
   * `requireAdmin` middlewares used throughout these routes.
   */
  private initializeRoutes(): void {
    this.routeAuth.startRoute();
    /** Middleware: resolves the bearer access token alnd rejects the request with 401 if it's
     * missing/invalid. */
    this.app.get("/serverHealth", (_req: Request, res: Response) => {
      res.json({ status: "ok", service: "obsync" });
    });

    const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const token = req.header("Authorization")?.replace(/^Bearer\s+/i, "");

      const authenticatedUser = await this.tokenService.verifyToken(token);

      if (!authenticatedUser) {
        res.status(401).json({ error: "Unauthorized." });

        return;
      }

      res.locals.authenticatedUser = authenticatedUser;
      res.locals.accessToken = token;
      next();
    };

    /** Middleware: rejects the request with 403 (and logs an audit entry) unless the authenticated
     * user is an admin. Must run after `requireAuth`. */
    const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
      const user = this.currentUser(res);

      if (user.role !== "admin") {
        this.auditDenied(user, req.method, req.path, this.requestPath(req));
        res.status(403).json({ error: "Only administrators can perform this action." });

        return;
      }

      next();
    };

    this.app.get("/serverHealth", (_req: Request, res: Response) => {
      res.json({ status: "ok", service: "obsync" });
    });

    this.app.patch(
      "/api/users/:id/name",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const normalizedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";

        if (!userId) {
          res.status(400).json({ error: "Invalid user." });
          return;
        }
        if (normalizedName.length < 2 || normalizedName.length > 64) {
          res.status(400).json({
            error: "The name must be between 2 and 64 characters.",
          });
          return;
        }
        const actor = this.currentUser(res);
        const target = await this.dbService.getUserById(userId, true);
        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            if (!target) {
              res.status(404).json({ error: "User not found." });
              return;
            }
            if (target.role === "admin" && target.id !== actor.id) {
              res.status(403).json({
                error: "Administrators can only change their own name.",
              });
              return;
            }

            const result = await this.dbService.updateUserName(userId, normalizedName);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`Something happened while changing ${userId} name`);
            res.status(500).json({
              error: "Something happened while changing some user name",
            });
          }
        });
      },
    );

    this.app.patch(
      "/api/users/:id/password",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const newPassword = req.body?.newPassword;

        if (!userId) {
          res.status(400).json({ error: "Invalid user." });
          return;
        }
        if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 128) {
          res.status(400).json({
            error: "The new password must be between 6 and 128 characters.",
          });
          return;
        }

        const target = await this.dbService.getUserById(userId, true);
        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            if (!target) {
              res.status(404).json({ error: "User not found." });
              return;
            }
            if (target.role !== "user") {
              res.status(403).json({
                error:
                  "Administrators can only reset a regular user's password. " +
                  "Use the self-service password change for your own account.",
              });
              return;
            }

            const result = await this.dbService.adminSetUserPassword(userId, newPassword);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error(`Something happened while changing ${userId} name`);

            res.status(500).json({
              error: "Something happened while changing some user password",
            });
          }
        });
      },
    );

    this.app.get(
      "/api/users",
      requireAuth,
      requireAdmin,
      async (_req: Request, res: Response): Promise<void> => {
        res.json({ users: await this.dbService.listUsers() });
      },
    );

    this.app.post(
      "/api/users",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const { name, email, password, role } = req.body ?? {};
        const normalizedName = typeof name === "string" ? name.trim() : "";
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
        const normalizedRole: UserRole = this.dbService.isUserRole(role) ? role : "user";

        if (normalizedName.length < 2 || normalizedName.length > 64) {
          res.status(400).json({ error: "The name must be between 2 and 64 characters." });
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          res.status(400).json({ error: "Enter a valid e-mail address." });
          return;
        }
        if (typeof password !== "string" || password.length < 6 || password.length > 128) {
          res.status(400).json({
            error: "The password must be between 6 and 128 characters.",
          });
          return;
        }
        const queue = this.queueManager.creatQueueOrReturn(email);

        queue.addTask(async () => {
          try {
            const result = await this.dbService.createUser(
              normalizedName,
              normalizedEmail,
              password,
              normalizedRole,
            );
            if (!result.ok) {
              res.status(409).json({
                error:
                  result.reason === "email_exists"
                    ? "A user with that e-mail already exists."
                    : "A user with that name already exists.",
                reason: result.reason,
              });
              return;
            }
            res.status(201).json({ user: result.user });
          } catch (error) {
            console.error(`Something happened while creating a new user`);

            res.status(500).json({
              error: "Something happened while creating a new user",
            });
          }
        });
      },
    );

    this.app.patch(
      "/api/users/:id/role",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const role = req.body?.role;
        if (!userId || !this.dbService.isUserRole(role)) {
          res.status(400).json({ error: "Invalid user or role." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserRole(userId, role);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while updating a user role");

            res.status(500).json({
              error: "Something happened while updating a user role",
            });
          }
        });
      },
    );

    this.app.patch(
      "/api/users/:id/status",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const active = req.body?.active;

        if (!userId || typeof active !== "boolean") {
          res.status(400).json({ error: "Invalid user or status." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));
        queue.addTask(async () => {
          try {
            const result = await this.dbService.updateUserStatus(userId, active);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while updating a user status");

            res.status(500).json({
              error: "Something happened while updating a user status",
            });
          }
        });
      },
    );

    this.app.delete(
      "/api/users/:id",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        if (!userId) {
          res.status(400).json({ error: "Invalid user." });
          return;
        }

        const queue = this.queueManager.creatQueueOrReturn(String(userId));

        queue.addTask(async () => {
          try {
            const result = await this.dbService.deleteUser(userId);
            if (!result.ok) {
              res.status(mutationErrorStatus(result)).json({
                error: mutationErrorMessage(result),
                reason: result.reason,
              });
              return;
            }
            res.json({ user: result.user });
          } catch (error) {
            console.error("Something happened while deleting a user ");

            res.status(500).json({
              error: "Something happened while deleting a user ",
            });
          }
        });
      },
    );

    this.app.post(
      "/api/syncfiles",
      requireAuth,
      async (_req: Request, res: Response): Promise<void> => {
        try {
          console.log("[ZIP] Starting compression...");
          await this.fileManager.directoryZiped();
          const zipPath = systemPaths.vaultExit;

          res.download(zipPath, "vault.zip", async (error) => {
            if (error) {
              console.error("[ZIP] Error sending file:", error.message);
              if (!res.headersSent) {
                res.status(500).json({ error: "Failed to send the files." });
              }
            } else {
              console.log("[ZIP] Sent successfully.");
            }

            try {
              await fs.unlink(zipPath);
            } catch (error) {
              console.error("[ZIP] Error cleaning up temporary file:", error);
            }
          });
        } catch (error) {
          console.error("[ZIP] General error:", error);
          res.status(500).json({ error: "Internal error generating the file." });
        }
      },
    );

    // Every global structure mutation requires authentication and the admin role.
    this.app.use("/sync", requireAuth, requireAdmin);

    this.app.post("/sync/create", async (req: Request, res: Response) => {
      try {
        const isBinary = req.is("application/octet-stream");
        const path = isBinary
          ? decodeURIComponent(req.header("x-obsync-path") ?? "")
          : req.body.path;
        const isFolder = isBinary ? req.header("X-ObSync-Is-Folder") === "true" : req.body.isFolder;

        const content = isBinary
          ? req.body
          : typeof req.body.content === "string"
            ? req.body.contenta
            : "";

        if (typeof path !== "string" || !path.trim()) {
          res.status(400).send("Invalid path");
          return;
        }

        if (this.collaborationServer.isPathDeleted(path)) {
          await this.collaborationServer.deletePersistedStateUnderPath(path);
        }
        this.collaborationServer.clearPathDeleted(path);

        if (isFolder) {
          await this.fileManager.createFolder(path);
        } else {
          await this.fileManager.createOrModifyFile(
            path,
            typeof content === "string" ? content : "",
          );
        }

        //spread vault changes to the WebSocket
        publishVaultChange({
          type: "create",
          path,
          isFolder: Boolean(isFolder),
          content: typeof content === "string" ? content : "",
          originClientId: req.header("x-obsync-client") ?? undefined,
        });

        res.sendStatus(200);
      } catch (error) {
        console.error("[Sync] Error in Create:", error);
        res.status(500).send("Error creating file or folder");
      }
    });

    this.app.delete("/sync/delete", async (req: Request, res: Response) => {
      try {
        const { path, isFolder } = req.body;
        if (typeof path !== "string" || !path.trim()) {
          res.status(400).send("Invalid path");
          return;
        }

        this.collaborationServer.markPathDeleted(path);
        try {
          await this.fileManager.deletePath(path);
        } catch (error) {
          this.collaborationServer.clearPathDeleted(path);
          throw error;
        }

        await this.collaborationServer.deletePersistedStateUnderPath(path);
        publishVaultChange({
          type: "delete",
          path,
          isFolder: Boolean(isFolder),
          originClientId: req.header("x-obsync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("[Sync] Error in Delete:", error);
        res.status(500).send("Error deleting");
      }
    });

    this.app.put("/sync/modify", async (req: Request, res: Response) => {
      try {
        const { path, content } = req.body;
        if (typeof path !== "string" || typeof content !== "string") {
          res.status(400).send("Invalid content or path");
          return;
        }
        if (this.collaborationServer.isPathDeleted(path)) {
          res.status(409).send("The path was deleted");
          return;
        }

        await this.fileManager.createOrModifyFile(path, content);
        publishVaultChange({
          type: "modify",
          path,
          content,
          originClientId: req.header("x-obsync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("[Sync] Error in Modify:", error);
        res.status(500).send("Error modifying file");
      }
    });

    this.app.put("/sync/rename", async (req: Request, res: Response) => {
      try {
        const { oldPath, newPath } = req.body;
        if (
          typeof oldPath !== "string" ||
          !oldPath.trim() ||
          typeof newPath !== "string" ||
          !newPath.trim()
        ) {
          res.status(400).send("Invalid path");
          return;
        }

        await this.fileManager.rename(oldPath, newPath);
        await this.collaborationServer.renamePersistedStatePath(oldPath, newPath);
        publishVaultChange({
          type: "rename",
          oldPath,
          newPath,
          originClientId: req.header("x-obsync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("[Sync] Error in Rename:", error);
        res.status(500).send("Error renaming");
      }
    });
  }

  /** Reads the authenticated user previously attached to the request by the `requireAuth` middleware. */
  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }
  /**
   * Parses and validates a route param as a positive user id.
   * @param value - The raw `:id` route param.
   * @returns The parsed id, or `null` if it's missing, an array, non-numeric, or not positive.
   */
  private parseUserId(value: string | string[] | undefined): number | null {
    if (Array.isArray(value)) return null;
    const userId = Number(value);
    return userId > 0 ? userId : null;
  }

  /** Extracts the vault path targeted by a sync request body (`path`, `oldPath`, or `newPath`), normalizing slashes. */
  private requestPath(req: Request): string | undefined {
    const value = req.body?.path ?? req.body?.oldPath ?? req.body?.newPath;
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
  }

  /** Logs an audit warning for an operation denied by `requireAdmin`. */
  private auditDenied(
    user: AuthenticatedUser,
    operation: string,
    route: string,
    targetPath?: string,
  ): void {
    console.warn("[Audit] Global operation blocked", {
      userId: user.id,
      role: user.role,
      operation,
      route,
      path: targetPath,
      timestamp: new Date().toISOString(),
      allowed: false,
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
