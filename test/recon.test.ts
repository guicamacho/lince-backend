/** Reconciliation comparator (Cluster 4): balance compare, in-flight tolerance, break dedupe. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { runReconOnce } from "../src/modules/ledger/recon.js";
import { resetDb, createOrg, seedBalance } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const reader = (balancesBySub: Record<string, Record<string, string>>) => ({
  async getBalances(sub?: string) {
    if (sub && sub in balancesBySub) return balancesBySub[sub]!;
    throw new Error("unknown subaccount");
  },
});

async function orgWithSub(sub: string): Promise<string> {
  const orgId = await createOrg("active");
  await pool.query("insert into avenia_accounts (org_id, subaccount_id) values ($1, $2)", [orgId, sub]);
  return orgId;
}

test("matching balances: clean run, no breaks", async () => {
  const orgId = await orgWithSub("sub_ok");
  await seedBalance(orgId, "BRLA", 10_000n); // R$100,00 owed
  const res = await runReconOnce(reader({ sub_ok: { BRLA: "100.00" } }));
  assert.equal(res.orgsChecked, 1);
  assert.equal(res.balanceDrifts, 0);
  assert.equal(res.missingPostings, 0);
  const run = await pool.query("select status from recon_runs where id = $1", [res.runId]);
  assert.equal(run.rows[0].status, "completed");
});

test("drift raises ONE break with case + ops alert; reruns do not duplicate", async () => {
  const orgId = await orgWithSub("sub_drift");
  await seedBalance(orgId, "BRLA", 10_000n);
  const r = reader({ sub_drift: { BRLA: "90.00" } }); // vendor says R$90 — R$10 short

  const first = await runReconOnce(r);
  assert.equal(first.balanceDrifts, 1);
  const brk = await pool.query<{ expected_minor: string; actual_minor: string; case_id: string }>(
    "select expected_minor, actual_minor, case_id from recon_breaks where break_type = 'balance_drift'",
  );
  assert.equal(brk.rows.length, 1);
  assert.equal(brk.rows[0]!.expected_minor, "10000");
  assert.equal(brk.rows[0]!.actual_minor, "9000");
  assert.ok(brk.rows[0]!.case_id, "linked to a recon_break case");
  const kase = await pool.query("select type, org_id from cases where id = $1", [brk.rows[0]!.case_id]);
  assert.equal(kase.rows[0].type, "recon_break");
  assert.equal(kase.rows[0].org_id, orgId);
  const alert = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'recon_break'",
  );
  assert.equal(alert.rows[0]!.n, 1, "the 4th Cluster-1 alert site fires");

  const second = await runReconOnce(r);
  assert.equal(second.balanceDrifts, 0, "open-break dedupe");
  const count = await pool.query("select count(*)::int as n from recon_breaks");
  assert.equal(count.rows[0]!.n, 1);
});

test("in-flight tolerance: a mid-flight org is skipped, not broken (Pattern 12)", async () => {
  const orgId = await orgWithSub("sub_flight");
  await seedBalance(orgId, "BRLA", 10_000n);
  await pool.query(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, provider_code, idem_key)
     values ($1,'payout','executing','BRLA',5000,'BRL','avenia',$2)`,
    [orgId, randomUUID()],
  );
  const res = await runReconOnce(reader({ sub_flight: { BRLA: "50.00" } })); // would be a huge drift
  assert.equal(res.skippedInFlight, 1);
  assert.equal(res.balanceDrifts, 0);
});

test("a settled transaction without ledger postings is a missing_posting break", async () => {
  const orgId = await orgWithSub("sub_mp");
  await pool.query(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, dest_amount, provider_code, idem_key)
     values ($1,'deposit','settled','BRL',10000,'BRLA',9980,'avenia',$2)`,
    [orgId, randomUUID()],
  );
  const first = await runReconOnce(reader({ sub_mp: { BRLA: "0" } }));
  assert.equal(first.missingPostings, 1);
  const brk = await pool.query("select expected_minor from recon_breaks where break_type = 'missing_posting'");
  assert.equal(brk.rows[0].expected_minor, "9980");
  const second = await runReconOnce(reader({ sub_mp: { BRLA: "0" } }));
  assert.equal(second.missingPostings, 0, "dedupe while the break stays open");
});

test("one org's vendor failure never kills the run", async () => {
  await orgWithSub("sub_gone"); // reader throws for it
  const ok = await orgWithSub("sub_fine");
  await seedBalance(ok, "USDT", 1_000_000n); // 1 USDT
  const res = await runReconOnce(reader({ sub_fine: { USDT: "1" } }));
  assert.equal(res.vendorErrors, 1);
  assert.equal(res.orgsChecked, 1);
  const run = await pool.query("select status from recon_runs where id = $1", [res.runId]);
  assert.equal(run.rows[0].status, "completed");
});
