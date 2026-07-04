import { test } from "node:test";
import assert from "node:assert/strict";
import { stepUpDecision } from "../src/modules/access/requireStepUp.js";

// Pure decision — the whole gate lives here; the middleware is thin glue over it.
test("flag off => ok regardless of auth", () => {
  assert.equal(stepUpDecision(false, undefined, false), "ok");
  assert.equal(stepUpDecision(false, "user_1", false), "ok");
});

test("enforced + no user => unauthenticated", () => {
  assert.equal(stepUpDecision(true, null, false), "unauthenticated");
});

test("enforced + user + stale reverification => step_up_required", () => {
  assert.equal(stepUpDecision(true, "user_1", false), "step_up_required");
});

test("enforced + user + fresh reverification => ok", () => {
  assert.equal(stepUpDecision(true, "user_1", true), "ok");
});
