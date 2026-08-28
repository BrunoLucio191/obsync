import type { AuthSession, StoredUserRow } from "./auth.types.ts";
import { normalizeEmailKey } from "../users/userNormalization.ts";
import { passwordMatches } from "./PasswordUtil.ts";
import type { DBServices } from "../users/DBServices.ts";
import type { UserDB } from "../users/UserDB.ts";
import type { TokenService } from "./TokenService.ts";

/** Handles credential-based login, turning an email/password pair into an {@link AuthSession}. */
export class AuthService {
  private readonly dbService: DBServices;
  private readonly userDB: UserDB;
  private readonly tokenService: TokenService;

  /**
   * @param userDB - Raw database handle used to look up the user row by email.
   * @param dbService - Service used to convert a raw DB row into an {@link AuthenticatedUser}.
   * @param tokenService - Service used to mint the session's tokens once credentials are verified.
   */
  constructor(userDB: UserDB, dbService: DBServices, tokenService: TokenService) {
    this.dbService = dbService;
    this.userDB = userDB;
    this.tokenService = tokenService;
  }

  /**
   * Verifies an email/password pair against the stored, active user and issues a new session on success.
   * @param email - The email address supplied by the client (matched case-insensitively via normalization).
   * @param password - The plaintext password supplied by the client.
   * @returns A new {@link AuthSession} if the credentials match an active user, otherwise `null`.
   */
  public async login(email: string, password: string): Promise<AuthSession | null | undefined> {
    const row = this.userDB
      .prepare(
        `SELECT id, email, name, password_hash, role, active
         FROM users WHERE email = ? AND active = 1`,
      )
      .get(normalizeEmailKey(email)) as StoredUserRow | undefined;
    if (!row || !(await passwordMatches(password, row.password_hash))) {
      return null;
    }

    return this.tokenService.sessionFor(this.dbService.rowToUser(row));
  }
}
