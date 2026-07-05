/** Migration smoke tests — one block per WP-B1 migration (0005–0008). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { resetDb, createOrg, createAdmin } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("0005 recon_runs / recon_breaks", async () => {
  const { rows: run } = await pool.query<{ id: string }>(
    "insert into recon_runs (scope) values ('daily') returning id",
  );
  const runId = run[0]!.id;

  const adminId = await createAdmin();
  const { rows: brk } = await pool.query<{ status: string }>(
    `insert into recon_breaks (run_id, break_type, resolved_by)
     values ($1, 'balance_drift', $2) returning status`,
    [runId, adminId],
  );
  assert.equal(brk[0]!.status, "open"); // status defaults 'open'

  await assert.rejects(
    pool.query("insert into recon_breaks (run_id, break_type) values ($1, 'bogus')", [runId]),
  );
});

test("0006 lifecycle + outbox + beneficiaries + cases re-cut", async () => {
  // orgs: terminal 'closed' + closed_at
  const orgId = await createOrg("active");
  await pool.query("update orgs set state = 'closed', closed_at = now() where id = $1", [orgId]);
  const { rows: org } = await pool.query<{ state: string }>(
    "select state from orgs where id = $1",
    [orgId],
  );
  assert.equal(org[0]!.state, "closed");

  // webhook_events: status 'dead', attempts defaults 0
  const { rows: wh } = await pool.query<{ attempts: number }>(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload, status)
     values ('avenia', 'evt_1', 'test', '{}', 'dead') returning attempts`,
  );
  assert.equal(wh[0]!.attempts, 0);

  // notification_outbox: status defaults 'queued'
  const { rows: out } = await pool.query<{ status: string }>(
    `insert into notification_outbox (event_type, recipient_ref, template_id)
     values ('org.activated', 'org:1', 'tmpl_1') returning status`,
  );
  assert.equal(out[0]!.status, "queued");

  // avenia_beneficiaries: verification_status defaults 'pending'; destination_kind CHECK
  const { rows: ben } = await pool.query<{ verification_status: string }>(
    `insert into avenia_beneficiaries (org_id, label) values ($1, 'Supplier')
     returning verification_status`,
    [orgId],
  );
  assert.equal(ben[0]!.verification_status, "pending");
  await assert.rejects(
    pool.query(
      "insert into avenia_beneficiaries (org_id, label, destination_kind) values ($1, 'Bad', 'bogus')",
      [orgId],
    ),
  );

  // cases: accepts new 'recon_break', rejects gated 'aml_alert'
  await pool.query("insert into cases (type) values ('recon_break')");
  await assert.rejects(pool.query("insert into cases (type) values ('aml_alert')"));
});

test("0008 case correspondence — append-only messages + customer inbox", async () => {
  const orgId = await createOrg("active");
  const { rows: c } = await pool.query<{ id: string }>(
    "insert into cases (type, org_id) values ('rfi_relay', $1) returning id",
    [orgId],
  );
  const caseId = c[0]!.id;

  // case_messages.customer_visible defaults false
  const { rows: m } = await pool.query<{ id: string; customer_visible: boolean }>(
    "insert into case_messages (case_id, author_type, body) values ($1, 'admin', 'hi') returning id, customer_visible",
    [caseId],
  );
  assert.equal(m[0]!.customer_visible, false);

  // author_type CHECK rejects a bogus value
  await assert.rejects(
    pool.query("insert into case_messages (case_id, author_type, body) values ($1, 'robot', 'x')", [caseId]),
  );

  // append-only: both UPDATE and DELETE are rejected (7-yr correspondence record)
  await assert.rejects(pool.query("update case_messages set body = 'edited' where id = $1", [m[0]!.id]));
  await assert.rejects(pool.query("delete from case_messages where id = $1", [m[0]!.id]));

  // customer_notifications: read_at null default + kind CHECK rejects a bogus value
  const { rows: n } = await pool.query<{ read_at: string | null }>(
    "insert into customer_notifications (org_id, kind, title, body) values ($1, 'case_message', 't', 'b') returning read_at",
    [orgId],
  );
  assert.equal(n[0]!.read_at, null);
  await assert.rejects(
    pool.query("insert into customer_notifications (org_id, kind, title, body) values ($1, 'bogus', 't', 'b')", [orgId]),
  );
});

test("0007 rate_limits fixed-window UPSERT increments", async () => {
  const upsert = `insert into rate_limits (key, route_class, window_start, count)
    values ('k1', 'cnpj', '2026-07-04T00:00:00Z', 1)
    on conflict (key, route_class, window_start)
    do update set count = rate_limits.count + 1
    returning count`;
  const first = await pool.query<{ count: number }>(upsert);
  const second = await pool.query<{ count: number }>(upsert);
  assert.equal(first.rows[0]!.count, 1);
  assert.equal(second.rows[0]!.count, 2);
});
