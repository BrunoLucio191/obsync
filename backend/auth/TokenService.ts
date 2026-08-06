import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AuthenticatedUser,
  AuthSession,
  TokenPayload,
} from "./auth.types.ts";
import { decode, encode } from "./encoding.ts";
import type { DBServices } from "../users/DBServices.ts";

export class TokenService {
  private secret: string;
  private readonly TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
  private dbService: DBServices;

  constructor(secret: string, dbService: DBServices) {
    this.secret = secret;
    this.dbService = dbService;
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }

  private issueToken(user: AuthenticatedUser): string {
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + this.TOKEN_LIFETIME_SECONDS,
    });
    const signed = `${header}.${payload}`;
    return `${signed}.${this.sign(signed)}`;
  }

  public sessionFor(user: AuthenticatedUser): AuthSession {
    return { token: this.issueToken(user), user };
  }
  public async verifyToken(
    token: string | null | undefined,
  ): Promise<AuthenticatedUser | null> {
    if (!token) return null;

    const [header, payload, signature] = token.split(".");

    if (!header || !payload || !signature) return null;

    const signed = `${header}.${payload}`;

    const expected = this.sign(signed);

    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return null;
    }

    try {
      const value = decode<TokenPayload>(payload);
      if (!value.id || value.exp < Math.floor(Date.now() / 1000)) return null;
      return await this.dbService.getUserById(value.id);
    } catch {
      return null;
    }
  }
}
