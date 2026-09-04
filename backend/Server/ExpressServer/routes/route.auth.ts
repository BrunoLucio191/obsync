import express, { type Request, type Response } from "express";
import { LoginRateLimiter } from "../../../auth/LoginRateLimiter.ts";
import type { AuthService } from "../../../auth/authService.ts";
import type { TokenService } from "../../../auth/TokenService.ts";
import type { DBServices } from "../../../users/DBServices.ts";
import type { AuthenticatedUser, WebSocketChannel } from "../../../auth/auth.types.ts";
import type { NextFunction } from "express";
import { mutationErrorMessage, mutationErrorStatus } from "../mutationFunctions.ts";

export class RouteAuth {
  public router: express.Router = express.Router();
  constructor(
    private readonly accountLoginRateLimiter: LoginRateLimiter,
    private readonly ipLoginRateLimiter: LoginRateLimiter,
    private readonly passwordChangeRateLimiter: LoginRateLimiter,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
    private readonly dbService: DBServices,
  ) {}

  private requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

  private currentUser(res: Response): AuthenticatedUser {
    return res.locals.authenticatedUser as AuthenticatedUser;
  }

  public startRoute() {
    this.router.post("/login", async (req: Request, res: Response): Promise<void> => {
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
      const accountLimit = this.accountLoginRateLimiter.check(accountKey);
      const ipLimit = this.ipLoginRateLimiter.check(ipKey);

      if (!accountLimit.allowed || !ipLimit.allowed) {
        res.setHeader(
          "Retry-After",
          Math.max(accountLimit.retryAfterSeconds, ipLimit.retryAfterSeconds),
        );
        res.status(429).json({ error: "Too many login attempts. Try again later." });

        return;
      }

      const session = await this.authService.login(email, password);

      if (!session) {
        const updatedAccountLimit = this.accountLoginRateLimiter.recordFailure(accountKey);
        const updatedIpLimit = this.ipLoginRateLimiter.recordFailure(ipKey);

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
      this.accountLoginRateLimiter.reset(accountKey);
      res.json(session);
    });

    this.router.post("/refresh", async (req: Request, res: Response): Promise<void> => {
      const refreshToken = req.body?.refreshToken;

      const session = await this.tokenService.refreshSession(
        typeof refreshToken === "string" ? refreshToken : null,
      );

      if (!session) {
        res.status(401).json({ error: "Invalid or expired session." });

        return;
      }

      res.json(session);
    });

    this.router.post("/logout", (req: Request, res: Response): void => {
      const refreshToken = req.body?.refreshToken;
      this.tokenService.revokeSession(typeof refreshToken === "string" ? refreshToken : null);

      res.sendStatus(204);
    });

    this.router.get("/me", this.requireAuth, (_req: Request, res: Response): void => {
      res.json({ user: this.currentUser(res) });
    });

    this.router.post(
      "/ws-ticket",
      this.requireAuth,
      async (req: Request, res: Response): Promise<void> => {
        const channel = req.body?.channel;

        function isWebSocketChannel(value: unknown): value is WebSocketChannel {
          return value === "system" || value === "yjs";
        }

        if (!isWebSocketChannel(channel)) {
          res.status(400).json({ error: "Invalid WebSocket channel." });

          return;
        }

        const ticket = await this.tokenService.issueWebSocketTicket(
          res.locals.accessToken,
          channel,
        );
        if (!ticket) {
          res.status(401).json({ error: "Invalid or expired session." });

          return;
        }
        res.json(ticket);
      },
    );

    this.router.post(
      "/change-password",
      this.requireAuth,
      async (req: Request, res: Response): Promise<void> => {
        const { currentPassword, newPassword } = req.body ?? {};
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

        const currentAuthenticatedUser = this.currentUser(res);
        const rateLimitKey = String(currentAuthenticatedUser.id);
        const limit = this.passwordChangeRateLimiter.check(rateLimitKey);
        if (!limit.allowed) {
          res.setHeader("Retry-After", limit.retryAfterSeconds);
          res.status(429).json({
            error: "Too many attempts. Try again later.",
          });

          return;
        }

        const result = await this.dbService.updateUserPassword(
          currentAuthenticatedUser.id,
          currentPassword,
          newPassword,
        );

        if (!result.ok) {
          if (result.reason === "invalid_current_password") {
            this.passwordChangeRateLimiter.recordFailure(rateLimitKey);
          }
          res.status(mutationErrorStatus(result)).json({
            error: mutationErrorMessage(result),
            reason: result.reason,
          });
          return;
        }

        this.passwordChangeRateLimiter.reset(rateLimitKey);
        res.json({ user: result.user });
      },
    );
  }
}
