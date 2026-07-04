/** Admission aging + latency (A3): pending sorted by elapsed, breach flag, non-pending
 *  excluded, percentiles over recorded admissions, empty-set safe. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { getAdmissionAging } from "../src/modules/admin/aging.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// Seed an org with a controlled forward/record timeline (days ago).
async function seed(opts: { forwardedDaysAgo: number; recordedDaysAgo?: number; state?: string }): Promise<string> {
  const orgId = await createOrg();
  await pool.query(
    `update orgs
        set kyb_forwarded_at      = now() - make_interval(days => $2::int),
            admission_recorded_at = case when $3::int is null then null else now() - make_interval(days => $3::int) end,
            admission_state       = $4
      where id = $1`,
    [orgId, opts.forwardedDaysAgo, opts.recordedDaysAgo ?? null, opts.state ?? "pending"],
  );
  return orgId;
}

test("pending sorted by elapsed desc; breach flips at threshold; non-pending excluded", async () => {
  const a = await seed({ forwardedDaysAgo: 5 });                                  // breached (>2d)
  const b = await seed({ forwardedDaysAgo: 1 });                                  // within SLA
  await seed({ forwardedDaysAgo: 3, recordedDaysAgo: 1, state: "approved" });     // decided -> excluded

  const aging = await getAdmissionAging(2);
  assert.equal(aging.threshold_days, 2);
  assert.equal(aging.pending_count, 2);
  assert.equal(aging.breach_count, 1);
  assert.equal(aging.pending[0]!.org_id, a); // oldest first
  assert.equal(aging.pending[0]!.breached, true);
  assert.equal(aging.pending[1]!.org_id, b);
  assert.equal(aging.pending[1]!.breached, false);
});

test("latency percentiles computed over recorded admissions (in days)", async () => {
  await seed({ forwardedDaysAgo: 10, recordedDaysAgo: 8, state: "approved" }); // 2-day admission
  const aging = await getAdmissionAging(2);
  assert.equal(aging.pending_count, 0);
  assert.equal(aging.latency.n, 1);
  assert.ok(Math.abs((aging.latency.p50_days ?? 0) - 2) < 0.01, `p50 ~= 2, got ${aging.latency.p50_days}`);
});

test("empty set is safe (no throw, null percentiles, zero counts)", async () => {
  const aging = await getAdmissionAging(2);
  assert.equal(aging.pending_count, 0);
  assert.equal(aging.breach_count, 0);
  assert.deepEqual(aging.pending, []);
  assert.equal(aging.latency.n, 0);
  assert.equal(aging.latency.p50_days, null);
});
