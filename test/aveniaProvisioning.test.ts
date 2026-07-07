/** ensureAveniaSubaccount: claim-row idempotency + failure release (Connectivity §3). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { ensureAveniaSubaccount } from "../src/modules/onboarding/aveniaProvisioning.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

function fakeClient(behavior: "ok" | "fail" = "ok") {
  let calls = 0;
  return {
    get calls() { return calls; },
    async createSubAccount(_name: string): Promise<{ id: string }> {
      calls++;
      if (behavior === "fail") throw new Error("avenia down");
      return { id: `sub_${calls}` };
    },
  };
}

test("creates the subaccount once, fills the row, audit-logs it", async () => {
  const orgId = await createOrg("pending_lince_approval");
  const client = fakeClient();
  const id = await ensureAveniaSubaccount(orgId, client);
  assert.equal(id, "sub_1");
  const row = await pool.query("select subaccount_id from avenia_accounts where org_id = $1", [orgId]);
  assert.equal(row.rows[0].subaccount_id, "sub_1");
  const audit = await pool.query(
    "select payload from audit_log where org_id = $1 and event = 'avenia.subaccount_created'", [orgId]);
  assert.equal(audit.rows[0].payload.subaccountId, "sub_1");
});

test("second call is a no-op returning the same id (RFI re-launch path)", async () => {
  const orgId = await createOrg("pending_lince_approval");
  const client = fakeClient();
  await ensureAveniaSubaccount(orgId, client);
  const again = await ensureAveniaSubaccount(orgId, client);
  assert.equal(again, "sub_1");
  assert.equal(client.calls, 1, "Avenia called exactly once");
});

test("Avenia failure releases the claim so a retry succeeds", async () => {
  const orgId = await createOrg("pending_lince_approval");
  await assert.rejects(() => ensureAveniaSubaccount(orgId, fakeClient("fail")), /verification_unavailable/);
  const rows = await pool.query("select 1 from avenia_accounts where org_id = $1", [orgId]);
  assert.equal(rows.rowCount, 0, "claim released");
  const id = await ensureAveniaSubaccount(orgId, fakeClient());
  assert.equal(id, "sub_1");
});

test("null client (keyless env) skips provisioning entirely", async () => {
  const orgId = await createOrg("pending_lince_approval");
  const id = await ensureAveniaSubaccount(orgId, null);
  assert.equal(id, null);
  const rows = await pool.query("select 1 from avenia_accounts where org_id = $1", [orgId]);
  assert.equal(rows.rowCount, 0);
});

test("unfilled claim held by another in-flight caller -> retryable 409", async () => {
  const orgId = await createOrg("pending_lince_approval");
  await pool.query("insert into avenia_accounts (org_id) values ($1)", [orgId]); // someone mid-flight
  await assert.rejects(() => ensureAveniaSubaccount(orgId, fakeClient()), /avenia_provisioning_in_progress/);
});
