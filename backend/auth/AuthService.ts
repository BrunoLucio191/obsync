import type { AuthSession, StoredUserRow } from "./auth.types.ts";
import { normalizeEmailKey } from "../users/userNormalization.ts";
import { passwordMatches } from "./PasswordUtil.ts";
import type { DBServices } from "../users/DBServices.ts";
import type { UserDB } from "../users/UserDB.ts";
import type { TokenService } from "./TokenService.ts";

export class AuthService {
  private readonly dbService: DBServices;
  private readonly userDB: UserDB;
  private readonly token: TokenService;
  constructor(userdb: UserDB, dbservice: DBServices, token: TokenService) {
    this.dbService = dbservice;
    this.userDB = userdb;
    this.token = token;
  }

  public async login(
    email: string,
    password: string,
  ): Promise<AuthSession | null> {
    const row = this.userDB
      .prepare(
        `SELECT id, email, name, password_hash, role, active
         FROM users WHERE email = ? AND active = 1`,
      )
      .get(normalizeEmailKey(email)) as StoredUserRow | undefined;
    if (!row || !(await passwordMatches(password, row.password_hash))) {
      return null;
    }

    return this.token.sessionFor(this.dbService.rowToUser(row));
  }
}
