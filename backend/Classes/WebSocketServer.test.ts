import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import type { DBServices } from "../users/DBServices.ts";
import type { AuthenticatedUser } from "../auth/auth.types.ts";
import { TokenService } from "../auth/TokenService.ts";
import { WebSHocket } from "./WebSocketServer.ts";

const USER: AuthenticatedUser = {
  id: 1,
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  active: true,
};

test("accepts one-use WebSocket tickets and rejects bearer query tokens", async () => {
  const dbService = {
    getUserById: async (userId: number) =>
      userId === USER.id ? { ...USER } : null,
  } as DBServices;
  const tokenService = new TokenService({
    secret: "s".repeat(64),
    dbService,
  });
  const session = tokenService.sessionFor(USER);
  const server = createServer();
  const webSockets = new WebSHocket(server, tokenService, false, false);
  webSockets.wssSystem.on("connection", (socket) => socket.close(1000));

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/system`;

  try {
    const issued = await tokenService.issueWebSocketTicket(
      session.token,
      "system",
    );
    assert.ok(issued);
    const protocol = `obisync-ticket.${issued.ticket}`;
    const accepted = new WebSocket(url, [protocol]);
    const acceptedClose = new Promise<void>((resolve) =>
      accepted.once("close", () => resolve()),
    );
    await new Promise<void>((resolve, reject) => {
      accepted.once("open", () => resolve());
      accepted.once("error", reject);
    });
    await acceptedClose;

    assert.equal(await rejectedStatus(url, protocol), 401);
    assert.equal(
      await rejectedStatus(`${url}?token=${encodeURIComponent(session.token)}`),
      401,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function rejectedStatus(url: string, protocol?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = protocol ? new WebSocket(url, [protocol]) : new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("A conexão WebSocket deveria ter sido recusada."));
    });
    socket.once("error", () => undefined);
  });
}
