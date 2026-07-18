/** Lifecycle completion (Cluster 3): voluntary closure under the money lock + the sweep jobs. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { closeOrgForOwner, runLifecycleSweep } from "../src/modules/lifecycle/closure.service.js";
import { activeMembershipForClerkUser } from "../src/modules/access/orgContext.js";
import { resetDb, createOrg, seedBalance } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const age = (orgId: string, days: number) =>
  pool.query(`update orgs set updated_at = now() - interval '${days} days' where id = $1`, [orgId]);

test("closeOrgForOwner: zero-balance active org closes — state, closed_at, audit, email", async () => {
  const orgId = await createOrg("active");
  const { closedAt } = await closeOrgForOwner(orgId, null);
  assert.ok(closedAt);
  const org = await pool.query("select state, closed_at from orgs where id = $1", [orgId]);
  assert.equal(org.rows[0].state, "closed");
  assert.ok(org.rows[0].closed_at);
  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'org.closed'", [orgId]);
  assert.equal(audit.rowCount, 1);
  const mail = await pool.query(
    "select 1 from notification_outbox where event_type = 'closure_completed' and recipient_ref = $1",
    [orgId],
  );
  assert.equal(mail.rowCount, 1);
});

test("closure refuses a non-zero balance and anything in flight", async () => {
  const withBalance = await createOrg("active");
  await seedBalance(withBalance, "BRLA", 10_000n);
  await assert.rejects(closeOrgForOwner(withBalance, null), /balance_not_zero/);

  const withInFlight = await createOrg("active");
  await pool.query(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, provider_code, idem_key)
     values ($1,'payout','created','BRLA',1000,'BRL','avenia',$2)`,
    [withInFlight, randomUUID()],
  );
  await assert.rejects(closeOrgForOwner(withInFlight, null), /transactions_in_flight/);

  const preActive = await createOrg("vendor_pending");
  await assert.rejects(closeOrgForOwner(preActive, null), /org_not_active/);
});

test("a closed org no longer resolves as an active membership (the /app gate closes itself)", async () => {
  const orgId = await createOrg("active");
  const person = await pool.query<{ id: string }>(
    `insert into people (full_name, email, can_login, clerk_user_id) values ('O','o@x.com',true,'clerk_closed') returning id`,
  );
  await pool.query(`insert into org_people (org_id, person_id, roles, status) values ($1,$2,'{owner}','active')`, [
    orgId,
    person.rows[0]!.id,
  ]);
  assert.ok(await activeMembershipForClerkUser("clerk_closed"));
  await closeOrgForOwner(orgId, person.rows[0]!.id);
  assert.equal(await activeMembershipForClerkUser("clerk_closed"), null);
});

test("stale sweep: 61d warns once (60d), 85d gets the FINAL warning only, reruns add nothing", async () => {
  const at61 = await createOrg("kyb_in_progress");
  await age(at61, 61);
  const at85 = await createOrg("rfi_required");
  await age(at85, 85);

  const first = await runLifecycleSweep();
  assert.equal(first.warned60, 1);
  assert.equal(first.warned80, 1);
  assert.equal(first.expired, 0);
  const w80 = await pool.query<{ payload: { daysLeft: number } }>(
    "select payload from notification_outbox where event_type = 'stale_warning_80d' and recipient_ref = $1",
    [at85],
  );
  assert.ok(w80.rows[0]!.payload.daysLeft >= 1 && w80.rows[0]!.payload.daysLeft <= 10);
  const w60For85 = await pool.query(
    "select 1 from notification_outbox where event_type = 'stale_warning_60d' and recipient_ref = $1",
    [at85],
  );
  assert.equal(w60For85.rowCount, 0, "an org past 80d gets only the final warning");

  const second = await runLifecycleSweep();
  assert.equal(second.warned60 + second.warned80, 0, "outbox-row dedupe holds");
});

test("stale sweep: 91d expires — soft-deleted, audited, notified; vendor_pending NEVER expires", async () => {
  const stale = await createOrg("pending_lince_approval");
  await age(stale, 91);
  const vendorQueue = await createOrg("vendor_pending");
  await age(vendorQueue, 120);

  const res = await runLifecycleSweep();
  assert.equal(res.expired, 1);
  const org = await pool.query("select deleted_at from orgs where id = $1", [stale]);
  assert.ok(org.rows[0].deleted_at, "soft-deleted");
  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'application.expired'", [stale]);
  assert.equal(audit.rowCount, 1);
  const mail = await pool.query(
    "select 1 from notification_outbox where event_type = 'application_expired' and recipient_ref = $1",
    [stale],
  );
  assert.equal(mail.rowCount, 1);

  const vp = await pool.query("select deleted_at from orgs where id = $1", [vendorQueue]);
  assert.equal(vp.rows[0].deleted_at, null, "Avenia's queue is not the customer's staleness");
});

test("dormancy: a long-quiet active org gets ONE neutral note per 90 days", async () => {
  const orgId = await createOrg("active");
  await pool.query(`update orgs set activated_at = now() - interval '200 days' where id = $1`, [orgId]);
  const first = await runLifecycleSweep();
  assert.equal(first.dormancyPinged, 1);
  const second = await runLifecycleSweep();
  assert.equal(second.dormancyPinged, 0, "90-day repeat guard");
  const mail = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'dormancy_outreach' and recipient_ref = $1",
    [orgId],
  );
  assert.equal(mail.rows[0]!.n, 1);
});

test("retention: old rejected orgs soft-delete with NO email (never-send list)", async () => {
  const orgId = await createOrg("rejected");
  await age(orgId, 100);
  const res = await runLifecycleSweep();
  assert.equal(res.retentionDeleted, 1);
  const org = await pool.query("select deleted_at from orgs where id = $1", [orgId]);
  assert.ok(org.rows[0].deleted_at);
  const mail = await pool.query("select count(*)::int as n from notification_outbox where recipient_ref = $1", [orgId]);
  assert.equal(mail.rows[0]!.n, 0, "no proactive contact with a rejected org, ever");
});

test("rate_limits GC: windows older than a day are dropped", async () => {
  await pool.query(
    `insert into rate_limits (key, route_class, window_start, count) values ('k','reads', now() - interval '2 days', 1)`,
  );
  const res = await runLifecycleSweep();
  assert.ok(res.rateWindowsDropped >= 1);
  const left = await pool.query("select 1 from rate_limits where key = 'k'");
  assert.equal(left.rowCount, 0);
});
