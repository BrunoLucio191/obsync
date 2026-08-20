import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { type Server } from "node:http";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { systemPaths } from "../paths.ts";
import type {
  AuthenticatedUser,
  UserMutationResult,
  UserRole,
  WebSocketChannel,
} from "../auth/auth.types.ts";
import { LoginRateLimiter } from "../auth/LoginRateLimiter.ts";
import { publishVaultChange } from "../syncEvents.ts";
import {
  clearPathDeleted,
  deletePersistedStateUnderPath,
  isPathDeleted,
  markPathDeleted,
  renamePersistedStatePath,
} from "../yjsUtils.ts";
import { FileManager } from "./FileManager.ts";
import { AuthService } from "../auth/authService.ts";
import type { TokenService } from "../auth/TokenService.ts";
import type { DBServices } from "../users/DBServices.ts";

function mutationErrorStatus(result: UserMutationResult): number {
  if (result.ok) return 200;
  switch (result.reason) {
    case "not_found":
      return 404;

    case "last_admin":
    case "self_deactivate":
    case "self_delete":
      return 409;

    case "invalid_role":
      return 400;

    case "name_exists":
      return 409;
  }
}

function mutationErrorMessage(result: UserMutationResult): string {
  if (result.ok) return "";

  switch (result.reason) {
    case "not_found":
      return "Usuário não encontrado.";

    case "last_admin":
      return "A operação deixaria a plataforma sem um administrador ativo.";

    case "self_deactivate":
      return "Você não pode desativar a própria conta. Peça a outro administrador.";

    case "self_delete":
      return "Você não pode excluir a própria conta pela sessão atual.";

    case "invalid_role":
      return "Papel de usuário inválido.";

    case "name_exists":
      return "Já existe um usuário com esse nome.";
  }
}

type ExpreeServerConstructor = {
  port: number;
  host: string;
  requireTls: boolean;
  trustProxy: boolean;
  fileManager: FileManager;
  tokenService: TokenService;
  dbService: DBServices;
  authService: AuthService;
};

export class ExpressServer {
  private readonly app: Express;
  private readonly port: number;
  private readonly host: string;
  private readonly requireTls: boolean;
  private readonly server: Server;
  private readonly filemanager: FileManager;
  private readonly dbService: DBServices;
  private readonly token: TokenService;
  private readonly auth: AuthService;
  private readonly accountLoginRateLimiter = new LoginRateLimiter({
    maxFailedAttempts: 5,
  });
  private readonly ipLoginRateLimiter = new LoginRateLimiter({
    maxFailedAttempts: 25,
  });

  constructor({
    port,
    host,
    requireTls,
    trustProxy,
    fileManager,
    tokenService,
    dbService,
    authService,
  }: ExpreeServerConstructor) {
    this.port = port;
    this.host = host;
    this.requireTls = requireTls;
    this.app = express();
    this.app.set("trust proxy", trustProxy);
    this.server = createServer(this.app);
    this.filemanager = fileManager;
    this.token = tokenService;
    this.dbService = dbService;
    this.auth = authService;
    this.initializeMiddleware();
    this.initializeRoutes();
  }

  public initializeMiddleware(): void {
    this.app.use((req, res, next) => {
      if (this.requireTls && !req.secure) {
        res
          .status(426)
          .json({ error: "Esta instalação exige conexão HTTPS." });
        return;
      }
      next();
    });
    this.app.use(express.json({ limit: "16mb" }));
    this.app.use("/auth", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      next();
    });
  }

  private initializeRoutes(): void {
    const requireAuth = async (
      req: Request,
      res: Response,
      next: NextFunction,
    ): Promise<void> => {
      const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");

      const authenticatedUser = await this.token.verifyToken(token);

      if (!authenticatedUser) {
        res.status(401).json({ error: "Não autorizado." });
        return;
      }

      res.locals.authenticatedUser = authenticatedUser;
      res.locals.accessToken = token;
      next();
    };

    const requireAdmin = (
      req: Request,
      res: Response,
      next: NextFunction,
    ): void => {
      const user = this.currentUser(res);

      if (user.role !== "admin") {
        this.auditDenied(user, req.method, req.path, this.requestPath(req));
        res
          .status(403)
          .json({ error: "Apenas administradores podem executar esta ação." });
        return;
      }

      next();
    };

    this.app.get("/", (_req: Request, res: Response) => {
      res.json({ status: "ok", service: "obsync" });
    });

    this.app.post(
      "/auth/login",
      async (req: Request, res: Response): Promise<void> => {
        const { email, password } = req.body ?? {};

        if (typeof email !== "string" || typeof password !== "string") {
          res.status(400).json({ error: "E-mail e senha são obrigatórios." });

          return;
        }
        if (email.length > 254 || password.length > 128) {
          res.status(400).json({ error: "Credenciais inválidas." });
          return;
        }

        const { accountKey, ipKey } = this.loginRateLimitKeys(req, email);
        const accountLimit = this.accountLoginRateLimiter.check(accountKey);
        const ipLimit = this.ipLoginRateLimiter.check(ipKey);
        if (!accountLimit.allowed || !ipLimit.allowed) {
          res.setHeader(
            "Retry-After",
            Math.max(
              accountLimit.retryAfterSeconds,
              ipLimit.retryAfterSeconds,
            ),
          );
          res.status(429).json({
            error: "Muitas tentativas de login. Tente novamente mais tarde.",
          });
          return;
        }

        const session = await this.auth.login(email, password);

        if (!session) {
          const updatedAccountLimit =
            this.accountLoginRateLimiter.recordFailure(accountKey);
          const updatedIpLimit = this.ipLoginRateLimiter.recordFailure(ipKey);
          if (!updatedAccountLimit.allowed || !updatedIpLimit.allowed) {
            res.setHeader(
              "Retry-After",
              Math.max(
                updatedAccountLimit.retryAfterSeconds,
                updatedIpLimit.retryAfterSeconds,
              ),
            );
            res.status(429).json({
              error: "Muitas tentativas de login. Tente novamente mais tarde.",
            });
            return;
          }
          res.status(401).json({ error: "E-mail ou senha inválidos." });

          return;
        }
        this.accountLoginRateLimiter.reset(accountKey);
        res.json(session);
      },
    );

    this.app.post(
      "/auth/refresh",
      async (req: Request, res: Response): Promise<void> => {
        const refreshToken = req.body?.refreshToken;
        const session = await this.token.refreshSession(
          typeof refreshToken === "string" ? refreshToken : null,
        );
        if (!session) {
          res.status(401).json({ error: "Sessão inválida ou expirada." });
          return;
        }

        res.json(session);
      },
    );

    this.app.post("/auth/logout", (req: Request, res: Response): void => {
      const refreshToken = req.body?.refreshToken;
      this.token.revokeSession(
        typeof refreshToken === "string" ? refreshToken : null,
      );
      res.sendStatus(204);
    });

    this.app.get(
      "/auth/me",
      requireAuth,
      (_req: Request, res: Response): void => {
        res.json({ user: this.currentUser(res) });
      },
    );

    this.app.post(
      "/auth/ws-ticket",
      requireAuth,
      async (req: Request, res: Response): Promise<void> => {
        const channel = req.body?.channel;
        if (!this.isWebSocketChannel(channel)) {
          res.status(400).json({ error: "Canal WebSocket inválido." });
          return;
        }

        const ticket = await this.token.issueWebSocketTicket(
          res.locals.accessToken as string,
          channel,
        );
        if (!ticket) {
          res.status(401).json({ error: "Sessão inválida ou expirada." });
          return;
        }

        res.json(ticket);
      },
    );

    this.app.patch(
      "/api/users/:id/name",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        const normalizedName =
          typeof req.body?.name === "string" ? req.body.name.trim() : "";

        if (!userId) {
          res.status(400).json({ error: "Usuário inválido." });
          return;
        }
        if (normalizedName.length < 2 || normalizedName.length > 64) {
          res.status(400).json({
            error: "O nome precisa ter entre 2 e 64 caracteres.",
          });
          return;
        }

        const actor = this.currentUser(res);
        const target = await this.dbService.getUserById(userId, true);
        if (!target) {
          res.status(404).json({ error: "Usuário não encontrado." });
          return;
        }
        if (target.role === "admin" && target.id !== actor.id) {
          res.status(403).json({
            error: "Administradores só podem alterar o próprio nome.",
          });
          return;
        }

        const result = await this.dbService.updateUserName(
          userId,
          normalizedName,
        );
        if (!result.ok) {
          res.status(mutationErrorStatus(result)).json({
            error: mutationErrorMessage(result),
          });
          return;
        }
        res.json({ user: result.user });
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
        const normalizedEmail =
          typeof email === "string" ? email.trim().toLowerCase() : "";
        const normalizedRole: UserRole = this.dbService.isUserRole(role)
          ? role
          : "user";

        if (normalizedName.length < 2 || normalizedName.length > 64) {
          res
            .status(400)
            .json({ error: "O nome precisa ter entre 2 e 64 caracteres." });
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          res.status(400).json({ error: "Informe um e-mail válido." });
          return;
        }
        if (
          typeof password !== "string" ||
          password.length < 6 ||
          password.length > 128
        ) {
          res
            .status(400)
            .json({ error: "A senha precisa ter entre 6 e 128 caracteres." });
          return;
        }

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
                ? "Já existe um usuário com esse e-mail."
                : "Já existe um usuário com esse nome.",
          });
          return;
        }
        res.status(201).json({ user: result.user });
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
          res.status(400).json({ error: "Usuário ou papel inválido." });
          return;
        }

        const result = await this.dbService.updateUserRole(userId, role);
        if (!result.ok) {
          res.status(mutationErrorStatus(result)).json({
            error: mutationErrorMessage(result),
          });
          return;
        }
        res.json({ user: result.user });
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
          res.status(400).json({ error: "Usuário ou status inválido." });
          return;
        }

        const actor = this.currentUser(res);
        const result = await this.dbService.updateUserStatus(
          actor.id,
          userId,
          active,
        );
        if (!result.ok) {
          res.status(mutationErrorStatus(result)).json({
            error: mutationErrorMessage(result),
          });
          return;
        }
        res.json({ user: result.user });
      },
    );

    this.app.delete(
      "/api/users/:id",
      requireAuth,
      requireAdmin,
      async (req: Request, res: Response): Promise<void> => {
        const userId = this.parseUserId(req.params.id);
        if (!userId) {
          res.status(400).json({ error: "Usuário inválido." });
          return;
        }

        const result = await this.dbService.deleteUser(
          this.currentUser(res).id,
          userId,
        );
        if (!result.ok) {
          res.status(mutationErrorStatus(result)).json({
            error: mutationErrorMessage(result),
          });
          return;
        }
        res.json({ user: result.user });
      },
    );

    this.app.post(
      "/api/syncfiles",
      requireAuth,
      async (_req: Request, res: Response): Promise<void> => {
        try {
          console.log("📦 [ZIP] Iniciando compactação...");
          await this.filemanager.directoryZiped();
          const zipPath = systemPaths.vaultExit;

          res.download(zipPath, "vault.zip", async (error) => {
            if (error) {
              console.error("❌ [ZIP] Erro no envio:", error.message);
              if (!res.headersSent) {
                res.status(500).json({ error: "Falha ao enviar os arquivos." });
              }
            } else {
              console.log("✅ [ZIP] Enviado com sucesso.");
            }

            await fs.unlink(zipPath).catch((unlinkError: unknown) => {
              if (
                unlinkError instanceof Error &&
                "code" in unlinkError &&
                (unlinkError as NodeJS.ErrnoException).code !== "ENOENT"
              ) {
                console.error(
                  "⚠️ [ZIP] Erro ao limpar arquivo temporário:",
                  unlinkError,
                );
              }
            });
          });
        } catch (error) {
          console.error("❌ [ZIP] Erro geral:", error);
          res.status(500).json({ error: "Erro interno ao gerar o arquivo." });
        }
      },
    );

    // Toda mutação global da estrutura exige autenticação e papel admin.
    this.app.use("/sync", requireAuth, requireAdmin);

    this.app.post("/sync/create", async (req: Request, res: Response) => {
      try {
        const { path, isFolder, content } = req.body;
        if (typeof path !== "string" || !path.trim()) {
          res.status(400).send("Caminho inválido");
          return;
        }

        if (isPathDeleted(path)) await deletePersistedStateUnderPath(path);
        clearPathDeleted(path);

        if (isFolder) await this.filemanager.createFolder(path);
        else
          await this.filemanager.createOrModifyFile(
            path,
            typeof content === "string" ? content : "",
          );

        publishVaultChange({
          type: "create",
          path,
          isFolder: Boolean(isFolder),
          content: typeof content === "string" ? content : "",
          originClientId: req.header("x-obisync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("❌ [Sync] Erro no Create:", error);
        res.status(500).send("Erro ao criar arquivo ou pasta");
      }
    });

    this.app.delete("/sync/delete", async (req: Request, res: Response) => {
      try {
        const { path, isFolder } = req.body;
        if (typeof path !== "string" || !path.trim()) {
          res.status(400).send("Caminho inválido");
          return;
        }

        markPathDeleted(path);
        try {
          await this.filemanager.deletePath(path);
        } catch (error) {
          clearPathDeleted(path);
          throw error;
        }

        await deletePersistedStateUnderPath(path);
        publishVaultChange({
          type: "delete",
          path,
          isFolder: Boolean(isFolder),
          originClientId: req.header("x-obisync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("[Sync] Erro no Delete:", error);
        res.status(500).send("Erro ao deletar");
      }
    });

    this.app.put("/sync/modify", async (req: Request, res: Response) => {
      try {
        const { path, content } = req.body;
        if (typeof path !== "string" || typeof content !== "string") {
          res.status(400).send("Conteúdo ou caminho inválido");
          return;
        }
        if (isPathDeleted(path)) {
          res.status(409).send("O caminho foi excluído");
          return;
        }

        await this.filemanager.createOrModifyFile(path, content);
        publishVaultChange({
          type: "modify",
          path,
          content,
          originClientId: req.header("x-obisync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("❌ [Sync] Erro no Modify:", error);
        res.status(500).send("Erro ao modificar arquivo");
      }
    });
    //TODO: fix bug when dealing with Tfolders
    this.app.put("/sync/rename", async (req: Request, res: Response) => {
      try {
        const { oldPath, newPath } = req.body;
        if (
          typeof oldPath !== "string" ||
          !oldPath.trim() ||
          typeof newPath !== "string" ||
          !newPath.trim()
        ) {
          res.status(400).send("Caminho inválido");
          return;
        }

        await this.filemanager.rename(oldPath, newPath);
        await renamePersistedStatePath(oldPath, newPath);
        publishVaultChange({
          type: "rename",
          oldPath,
          newPath,
          originClientId: req.header("x-obisync-client") ?? undefined,
        });
        res.sendStatus(200);
      } catch (error) {
        console.error("❌ [Sync] Erro no Rename:", error);
        res.status(500).send("Erro ao renomear");
      }
    });
  }

  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  private isWebSocketChannel(value: unknown): value is WebSocketChannel {
    return value === "system" || value === "yjs";
  }

  private loginRateLimitKeys(
    req: Request,
    email: string,
  ): { accountKey: string; ipKey: string } {
    const normalizedEmail = email.normalize("NFKC").trim().toLowerCase();
    const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
    return {
      accountKey: `account:${normalizedEmail}`,
      ipKey: `ip:${address}`,
    };
  }

  private parseUserId(value: string | string[] | undefined): number | null {
    if (Array.isArray(value)) return null;
    const userId = Number(value);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  }

  private requestPath(req: Request): string | undefined {
    const value = req.body?.path ?? req.body?.oldPath ?? req.body?.newPath;
    return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
  }

  private auditDenied(
    user: AuthenticatedUser,
    operation: string,
    route: string,
    targetPath?: string,
  ): void {
    console.warn("[Audit] Operação global bloqueada", {
      userId: user.id,
      role: user.role,
      operation,
      route,
      path: targetPath,
      timestamp: new Date().toISOString(),
      allowed: false,
    });
  }

  public serverStart(port = this.port): void {
    this.server.once("error", (error) => {
      console.error(
        `Não foi possível iniciar o servidor na porta ${port}:`,
        error,
      );
    });
    this.server.listen(port, this.host, () => {
      if (this.requireTls) {
        console.log(
          `Server running behind a trusted TLS proxy on ${this.host}:${port}`,
        );
        return;
      }
      console.log(`Server running on http://${this.host}:${port}`);
    });
  }

  get getHttpServer(): Server {
    return this.server;
  }
}
