/** 24h post-recovery money-out hold — append-only audit_log seam, time-based expiry. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import {
  registerPostRecoveryHold,
  moneyOutHoldActive,
  isMoneyOutHeld,
} from "../src/modules/access/recoveryHold.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// Pure predicate — no DB.
test("isMoneyOutHeld: held before until, clear after, false with no hold", () => {
  const until = "2026-07-04T12:00:00.000Z";
  assert.equal(isMoneyOutHeld({ until }, new Date("2026-07-04T11:59:59.000Z")), true);
  assert.equal(isMoneyOutHeld({ until }, new Date("2026-07-04T12:00:01.000Z")), false);
  assert.equal(isMoneyOutHeld(null, new Date()), false);
  assert.equal(isMoneyOutHeld(undefined, new Date()), false);
});

test("registerPostRecoveryHold writes one system audit event carrying payload.until", async () => {
  const orgId = await createOrg();
  const until = await registerPostRecoveryHold(orgId, 24, "user_x");

  const { rows } = await pool.query(
    "select actor_type, actor_id, event, payload from audit_log where org_id = $1",
    [orgId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, "system");
  assert.equal(rows[0].actor_id, "user_x");
  assert.equal(rows[0].event, "security.post_recovery_hold");
  assert.equal(rows[0].payload.until, until);
});

test("moneyOutHoldActive honours the 24h window (fixed now)", async () => {
  const orgId = await createOrg();
  await registerPostRecoveryHold(orgId, 24, null);

  const now = new Date();
  assert.equal(await moneyOutHoldActive(orgId, now), true);
  assert.equal(await moneyOutHoldActive(orgId, new Date(now.getTime() + 25 * 3_600_000)), false);
});

test("moneyOutHoldActive reads the LATEST hold, not an older expired one", async () => {
  const orgId = await createOrg();
  // A back-dated, already-expired hold written directly (append-only insert is allowed).
  await pool.query(
    `insert into audit_log (org_id, actor_type, event, payload, created_at)
     values ($1, 'system', 'security.post_recovery_hold', $2, now() - interval '2 days')`,
    [orgId, JSON.stringify({ until: new Date(Date.now() - 24 * 3_600_000).toISOString() })],
  );
  await registerPostRecoveryHold(orgId, 24, null);

  assert.equal(await moneyOutHoldActive(orgId), true);
});

test("moneyOutHoldActive is false when the org has no hold", async () => {
  const orgId = await createOrg();
  assert.equal(await moneyOutHoldActive(orgId), false);
});
