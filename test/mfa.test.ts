import { test } from "node:test";
import assert from "node:assert/strict";
import { mfaDecision } from "../src/modules/access/requireMfa.js";

// Pure decision — the whole gate lives here; the middleware is thin glue over it.
test("policy optional => ok regardless of factors (ratified default)", () => {
  assert.equal(mfaDecision("optional", undefined, false), "ok");
  assert.equal(mfaDecision("optional", "user_1", false), "ok");
});

test("mandatory + no user => unauthenticated", () => {
  assert.equal(mfaDecision("mandatory", null, false), "unauthenticated");
});

test("mandatory + user + no second factor => mfa_required", () => {
  assert.equal(mfaDecision("mandatory", "user_1", false), "mfa_required");
});

test("mandatory + user + second factor present => ok", () => {
  assert.equal(mfaDecision("mandatory", "user_1", true), "ok");
});
