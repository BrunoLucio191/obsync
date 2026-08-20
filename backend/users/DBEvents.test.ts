import assert from "node:assert/strict";
import test from "node:test";
import { dbEvents } from "./DBEvents.ts";

test("shares authorization changes across backend services", () => {
  let receivedUserId: number | null = null;
  const unsubscribe = dbEvents().onAuthorizationChanged((userId) => {
    receivedUserId = userId;
  });

  dbEvents().emitAuthorizationChanged(42);

  assert.equal(receivedUserId, 42);
  unsubscribe();
});
