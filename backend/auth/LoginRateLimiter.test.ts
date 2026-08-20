import assert from "node:assert/strict";
import test from "node:test";
import { LoginRateLimiter } from "./LoginRateLimiter.ts";

test("blocks a login key after five failed attempts", () => {
  const limiter = new LoginRateLimiter();
  const key = "127.0.0.1:admin@example.com";

  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal(limiter.recordFailure(key).allowed, true);
  }

  const blocked = limiter.recordFailure(key);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.check(key).allowed, false);

  limiter.reset(key);
  assert.equal(limiter.check(key).allowed, true);
});
