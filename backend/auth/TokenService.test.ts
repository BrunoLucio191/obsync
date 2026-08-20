import assert from "node:assert/strict";
import test from "node:test";
import type { DBServices } from "../users/DBServices.ts";
import type { AuthenticatedUser } from "./auth.types.ts";
import { TokenService } from "./TokenService.ts";

const USER: AuthenticatedUser = {
  id: 1,
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  active: true,
};

function createService(): TokenService {
  const dbService = {
    getUserById: async (userId: number) =>
      userId === USER.id ? { ...USER } : null,
  } as DBServices;
  return new TokenService({ secret: "s".repeat(64), dbService });
}

test("rejects signing secrets shorter than 32 bytes", () => {
  const dbService = {} as DBServices;
  assert.throws(
    () => new TokenService({ secret: "short", dbService }),
    /pelo menos 32 bytes/,
  );
});

test("rotates refresh tokens and revokes the complete session", async () => {
  const service = createService();
  const initial = service.sessionFor(USER);

  assert.equal((await service.verifyToken(initial.token))?.id, USER.id);
  const refreshed = await service.refreshSession(initial.refreshToken);
  assert.ok(refreshed);
  assert.notEqual(refreshed.refreshToken, initial.refreshToken);
  assert.equal(await service.refreshSession(initial.refreshToken), null);
  assert.equal((await service.verifyToken(refreshed.token))?.id, USER.id);

  service.revokeSession(refreshed.refreshToken);
  assert.equal(await service.verifyToken(refreshed.token), null);
});

test("issues scoped, one-use WebSocket tickets", async () => {
  const service = createService();
  const session = service.sessionFor(USER);
  const firstTicket = await service.issueWebSocketTicket(
    session.token,
    "system",
  );
  assert.ok(firstTicket);

  const authorization = await service.consumeWebSocketTicket(
    firstTicket.ticket,
    "system",
  );
  assert.equal(authorization?.user.id, USER.id);
  assert.equal(
    await service.consumeWebSocketTicket(firstTicket.ticket, "system"),
    null,
  );

  const yjsTicket = await service.issueWebSocketTicket(session.token, "yjs");
  assert.ok(yjsTicket);
  assert.equal(
    await service.consumeWebSocketTicket(yjsTicket.ticket, "system"),
    null,
  );
});
