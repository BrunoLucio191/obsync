import { type Request, type Response } from "express";
import { LoginRateLimiter } from "../../../../auth/LoginRateLimiter.ts";
import type { AuthService } from "../../../../auth/authService.ts";
import type { TokenService } from "../../../../auth/TokenService.ts";
import type { AuthenticatedUser } from "../../../../auth/auth.types.ts";
import type { WebSocketChannel } from "../../../../auth/auth.types.ts";
import { QueueManager } from "../../../../queue/QueueManager.ts";
import {
  UserMutationErrorMessage,
  userMutationErrorStatus,
} from "../mutationMessage/userMessageMutation.ts";
import { DBServices } from "../../../../users/DBServices.ts";

export type AuthControllerContructor = {
  accountLoginRateLimiter: LoginRateLimiter;
  ipLoginRateLimiter: LoginRateLimiter;
  authService: AuthService;
  tokenService: TokenService;
  passwordChangeRateLimiter: LoginRateLimiter;
  queueManager: QueueManager;
  dbService: DBServices;
};

export class AuthController {
  readonly #accountLoginRateLimiter: LoginRateLimiter;
  readonly #ipLoginRateLimiter: LoginRateLimiter;
  readonly #authService: AuthService;
  readonly #tokenService: TokenService;
  readonly #passwordChangeRateLimiter: LoginRateLimiter;
  readonly #queueManager: QueueManager;
  readonly #dbService: DBServices;
  constructor({
    accountLoginRateLimiter,
    ipLoginRateLimiter,
    authService,
    tokenService,
    passwordChangeRateLimiter,
    queueManager,
    dbService,
  }: AuthControllerContructor) {
    this.#queueManager = queueManager;
    this.#dbService = dbService;
    this.#passwordChangeRateLimiter = passwordChangeRateLimiter;
    this.#accountLoginRateLimiter = accountLoginRateLimiter;
    this.#ipLoginRateLimiter = ipLoginRateLimiter;
    this.#authService = authService;
    this.#tokenService = tokenService;
  }
  login = async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};

    switch (true) {
      case typeof email !== "string" || typeof password !== "string":
        res.status(400).json({ error: "E-mail and password are required" });
        return;
      case !email.includes("@") || email.length < 10 || email.trim().length === 0:
        res.status(400).json({ error: "E-mail is not valid" });
        return;
      case password.trim().length === 0:
        res.status(400).json({ error: "password is not valid" });
        return;
      case email.length > 254 || password.length > 128:
        res.status(400).json({ error: "Invalid credentials" });
        return;
    }

    function loginRateLimitKeys(
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

    const { accountKey, ipKey } = loginRateLimitKeys(req, email);
    const accountLimit = this.#accountLoginRateLimiter.check(accountKey);
    const ipLimit = this.#ipLoginRateLimiter.check(ipKey);

    if (!accountLimit.allowed || !ipLimit.allowed) {
      res.setHeader(
        "Retry-After",
        Math.max(accountLimit.retryAfterSeconds, ipLimit.retryAfterSeconds),
      );
      res.status(429).json({ error: "Too many login attempts. Try again later." });

      return;
    }

    const session = await this.#authService.login(email, password);

    if (!session) {
      const updatedAccountLimit = this.#accountLoginRateLimiter.recordFailure(accountKey);
      const updatedIpLimit = this.#ipLoginRateLimiter.recordFailure(ipKey);

      if (!updatedAccountLimit.allowed || !updatedIpLimit.allowed) {
        res.setHeader(
          "Retry-After",
          Math.max(updatedAccountLimit.retryAfterSeconds, updatedIpLimit.retryAfterSeconds),
        );
        res.status(429).json({ error: "Too many login attempts. Try again later." });

        return;
      }
      res.status(401).json({ error: "Invalid e-mail or password." });

      return;
    }
    this.#accountLoginRateLimiter.reset(accountKey);
    res.json(session);
  };

  refreash = async (req: Request, res: Response): Promise<void> => {
    const refreshToken = req.body?.refreshToken;

    const session = await this.#tokenService.refreshSession(
      typeof refreshToken === "string" ? refreshToken : null,
    );

    if (!session) {
      res.status(401).json({ error: "Invalid or expired session." });

      return;
    }

    res.json(session);
  };

  logout = (req: Request, res: Response): void => {
    const refreshToken = req.body?.refreshToken;
    this.#tokenService.revokeSession(typeof refreshToken === "string" ? refreshToken : null);

    res.sendStatus(204);
  };

  me = (_req: Request, res: Response): void => {
    res.json({ user: this.#currentUser(res) });
  };

  wsTicket = async (req: Request, res: Response): Promise<void> => {
    const channel = req.body?.channel;

    function isWebSocketChannel(value: unknown): value is WebSocketChannel {
      return value === "system" || value === "yjs";
    }

    if (!isWebSocketChannel(channel)) {
      res.status(400).json({ error: "Invalid WebSocket channel." });

      return;
    }

    const ticket = await this.#tokenService.issueWebSocketTicket(res.locals.accessToken, channel);
    if (!ticket) {
      res.status(401).json({ error: "Invalid or expired session." });

      return;
    }
    res.json(ticket);
  };
  changePassword = async (req: Request, res: Response): Promise<void> => {
    const { currentPassword, newPassword } = req.body ?? {};
    const { ["x-obsync-client"]: clientId } = req.headers;

    if (typeof clientId !== "string" || clientId === undefined) {
      console.warn("[Auth] Missing clientId inside the header");
      res.status(400).json({ error: "Missing clientId inside the header" });
      return;
    }

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 6 ||
      newPassword.length > 128
    ) {
      res.status(400).json({
        error: "The new password must be between 6 and 128 characters.",
      });

      return;
    }

    const actor = this.#currentUser(res);
    const rateLimitKey = String(actor.id);
    const limit = this.#passwordChangeRateLimiter.check(rateLimitKey);
    if (!limit.allowed) {
      res.setHeader("Retry-After", limit.retryAfterSeconds);
      console.error("[Auth] Too many attempts. Try again later.");
      res.status(429).json({
        error: "Too many attempts. Try again later.",
      });
      return;
    }
    const queue = this.#queueManager.getOrCreateQueue(String(clientId));
    const result = await queue.addTask(async () => {
      const result = await this.#dbService.updateUserPassword(
        actor.id,
        currentPassword,
        newPassword,
      );

      if (!result.ok) {
        if (result.reason === "INVALID_CURRENT_PASSWORD") {
          this.#passwordChangeRateLimiter.recordFailure(rateLimitKey);
        }
        res.status(userMutationErrorStatus(result)).json({
          error: UserMutationErrorMessage(result),
          reason: result.reason,
        });
        return;
      }

      this.#passwordChangeRateLimiter.reset(rateLimitKey);
      res.json({ user: result.user });
    }, `auth:${actor.id}:changePassword`);
    res.json(result);
  };

  #currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }
}
