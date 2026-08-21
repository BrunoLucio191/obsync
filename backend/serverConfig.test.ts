import assert from "node:assert/strict";
import test from "node:test";
import { loadServerConfig } from "./serverConfig.ts";

test("defaults to an HTTP loopback-only development server", () => {
  const config = loadServerConfig({
    OBSYNC_TOKEN_SECRET: "s".repeat(64),
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3_000);
  assert.equal(config.requireTls, false);
});

test("refuses plaintext transport on non-loopback interfaces", () => {
  assert.throws(
    () =>
      loadServerConfig({
        OBSYNC_HOST: "0.0.0.0",
        OBSYNC_REQUIRE_TLS: "false",
        OBSYNC_TOKEN_SECRET: "s".repeat(64),
      }),
    /OBSYNC_REQUIRE_TLS/,
  );
});

test("requires an explicitly trusted TLS reverse proxy", () => {
  assert.throws(
    () =>
      loadServerConfig({
        OBSYNC_HOST: "0.0.0.0",
        OBSYNC_REQUIRE_TLS: "true",
        OBSYNC_TRUST_PROXY: "false",
        OBSYNC_TOKEN_SECRET: "s".repeat(64),
      }),
    /OBSYNC_TRUST_PROXY/,
  );
});
