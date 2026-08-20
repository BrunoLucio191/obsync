import assert from "node:assert/strict";
import test from "node:test";
import { loadServerConfig } from "./serverConfig.ts";

test("defaults to an HTTP loopback-only development server", () => {
  const config = loadServerConfig({
    OBISYNC_TOKEN_SECRET: "s".repeat(64),
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3_000);
  assert.equal(config.requireTls, false);
});

test("refuses plaintext transport on non-loopback interfaces", () => {
  assert.throws(
    () =>
      loadServerConfig({
        OBISYNC_HOST: "0.0.0.0",
        OBISYNC_REQUIRE_TLS: "false",
        OBISYNC_TOKEN_SECRET: "s".repeat(64),
      }),
    /OBISYNC_REQUIRE_TLS/,
  );
});

test("requires an explicitly trusted TLS reverse proxy", () => {
  assert.throws(
    () =>
      loadServerConfig({
        OBISYNC_HOST: "0.0.0.0",
        OBISYNC_REQUIRE_TLS: "true",
        OBISYNC_TRUST_PROXY: "false",
        OBISYNC_TOKEN_SECRET: "s".repeat(64),
      }),
    /OBISYNC_TRUST_PROXY/,
  );
});
