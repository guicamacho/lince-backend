import { test } from "node:test";
import assert from "node:assert/strict";
import { mfaDecision, mfaEnrolledGate } from "../src/modules/access/requireMfa.js";

// --- pure global-policy decision (enrollment-based) ---
test("policy optional => ok regardless of enrollment (ratified default)", () => {
  assert.equal(mfaDecision("optional", undefined, false), "ok");
  assert.equal(mfaDecision("optional", "user_1", false), "ok");
});
test("mandatory + no user => unauthenticated", () => {
  assert.equal(mfaDecision("mandatory", null, false), "unauthenticated");
});
test("mandatory + user + not enrolled => mfa_required", () => {
  assert.equal(mfaDecision("mandatory", "user_1", false), "mfa_required");
});
test("mandatory + user + enrolled => ok", () => {
  assert.equal(mfaDecision("mandatory", "user_1", true), "ok");
});

// --- the payee/money-out gate: authoritative enrollment, FAIL-CLOSED ---
const enrolled = async () => true;
const notEnrolled = async () => false;
const throws = async (): Promise<boolean> => {
  throw new Error("clerk down");
};

test("enrolled user => ok (money-out allowed)", async () => {
  assert.equal(await mfaEnrolledGate("user_1", enrolled), "ok");
});

test("not-enrolled user => 403 mfa_required (blocked, the first-payee trigger)", async () => {
  const r = await mfaEnrolledGate("user_1", notEnrolled);
  assert.deepEqual(r, { status: 403, body: { error: "mfa_required", action: "enrol" } });
});

test("no userId => 401", async () => {
  assert.deepEqual(await mfaEnrolledGate(null, enrolled), { status: 401, body: { error: "unauthenticated" } });
  assert.deepEqual(await mfaEnrolledGate(undefined, enrolled), { status: 401, body: { error: "unauthenticated" } });
});

test("lookup throws => FAILS CLOSED (503, never ok)", async () => {
  const r = await mfaEnrolledGate("user_1", throws);
  assert.notEqual(r, "ok", "must NOT allow the money-out action when enrollment can't be verified");
  assert.deepEqual(r, { status: 503, body: { error: "mfa_check_unavailable" } });
});
