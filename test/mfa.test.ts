import { test } from "node:test";
import assert from "node:assert/strict";
import { mfaDecision, hasSecondFactor } from "../src/modules/access/requireMfa.js";

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

// hasSecondFactor reads the Clerk fva claim [firstFactorAge, secondFactorAge].
// -1 (or missing) second-factor age = not enrolled; any real age = enrolled.
test("hasSecondFactor: fva[1] === -1 => not enrolled", () => {
  assert.equal(hasSecondFactor([0, -1]), false);
});
test("hasSecondFactor: fva[1] is a real age => enrolled (payee gate passes)", () => {
  assert.equal(hasSecondFactor([12, 0]), true);
  assert.equal(hasSecondFactor([12, 300]), true);
});
test("hasSecondFactor: missing/short claim => not enrolled (fail closed)", () => {
  assert.equal(hasSecondFactor(undefined), false);
  assert.equal(hasSecondFactor([0]), false);
  assert.equal(hasSecondFactor("nope"), false);
});
