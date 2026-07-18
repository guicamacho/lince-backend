/**
 * Notification delivery integrity (Completion Register, Cluster 1) against lince_test:
 * recipient resolution (org -> owner email), suppression, dead-letter ops alerts,
 * the Resend bounce handler, ticket-outcome enqueues, and the SLA breach sweep.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../src/db/pool.js";
import { enqueueNotification, drainOutboxOnce } from "../src/modules/notifications/outbox.js";
import type { NotifyConfig, SendAdapter } from "../src/modules/notifications/adapters.js";
import { drainWebhooks } from "../src/modules/webhooks/processor.js";
import { alertSlaBreachesOnce } from "../src/modules/admin/aging.js";
import { resetDb, createOrg, settleTicket } from "./helpers.js";

const cfg: NotifyConfig = { emailAdapter: "log" };

beforeEach(resetDb);
after(() => pool.end());

/** Capturing adapter: records every (to, rendered) it is asked to send. */
function capturing() {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const adapter: SendAdapter = {
    async send(rendered, to, key) {
      sent.push({ to, subject: rendered.subject, body: rendered.body });
      return { ok: true, providerRef: `cap:${key}` };
    },
  };
  return { sent, adapter };
}

async function orgWithOwner(email: string): Promise<string> {
  const orgId = await createOrg("active");
  const person = await pool.query<{ id: string }>(
    `insert into people (full_name, email, can_login) values ('Owner', $1, true) returning id`,
    [email],
  );
  await pool.query(`insert into org_people (org_id, person_id, roles, status) values ($1, $2, '{owner}', 'active')`, [
    orgId,
    person.rows[0]!.id,
  ]);
  return orgId;
}

async function enqueue(recipientRef: string): Promise<void> {
  await withTransaction((c) =>
    enqueueNotification(c, { eventType: "t", recipientRef, templateId: "activation_approved" }),
  );
}

const rowsFor = (where: string, params: unknown[]) =>
  pool.query<{ id: string; status: string; recipient_ref: string; provider_ref: string | null; payload: { summary?: string } }>(
    `select id, status, recipient_ref, provider_ref, payload from notification_outbox where ${where}`,
    params,
  );

test("org-ref resolution: a customer send goes to the active owner's email, lowercased", async () => {
  const orgId = await orgWithOwner("Owner@Empresa.Com.BR");
  const { sent, adapter } = capturing();
  await enqueue(orgId);
  await drainOutboxOnce(cfg, () => adapter);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "owner@empresa.com.br");
  const { rows } = await rowsFor("recipient_ref = $1", [orgId]);
  assert.equal(rows[0]!.status, "sent");
  assert.equal(rows[0]!.provider_ref, `cap:${rows[0]!.id}`);
});

test("unresolvable ref dead-letters WITHOUT sending and pings ops (notification_dead alert)", async () => {
  const ref = randomUUID(); // no such org, no "@"
  const { sent, adapter } = capturing();
  await enqueue(ref);
  await drainOutboxOnce(cfg, () => adapter);
  assert.equal(sent.length, 0);
  const { rows } = await rowsFor("recipient_ref = $1", [ref]);
  assert.equal(rows[0]!.status, "dead");
  const alert = await pool.query(`select 1 from notification_outbox where event_type = 'notification_dead'`);
  assert.equal(alert.rowCount, 1);
});

test("suppressed recipient dead-letters instead of sending (bounce protection)", async () => {
  const orgId = await orgWithOwner("bounced@empresa.com.br");
  await pool.query(`insert into notification_suppressions (email, reason) values ('bounced@empresa.com.br', 'bounced')`);
  const { sent, adapter } = capturing();
  await enqueue(orgId);
  await drainOutboxOnce(cfg, () => adapter);
  assert.equal(sent.length, 0);
  const { rows } = await rowsFor("recipient_ref = $1", [orgId]);
  assert.equal(rows[0]!.status, "dead");
});

test("resend bounce webhook suppresses the address; complaints too; other events don't", async () => {
  const insert = (type: string, to: string) =>
    pool.query(
      `insert into webhook_events (provider_code, external_event_id, event_type, payload)
       values ('resend', $1, $2, $3)`,
      [randomUUID(), type, JSON.stringify({ type, data: { email_id: "em_1", to: [to] } })],
    );
  await insert("email.bounced", "Hard@Bounce.com");
  await insert("email.complained", "spam@flag.com");
  await insert("email.delivered", "fine@ok.com");
  await drainWebhooks();
  const { rows } = await pool.query<{ email: string; reason: string }>(
    `select email, reason from notification_suppressions order by email`,
  );
  assert.deepEqual(rows, [
    { email: "hard@bounce.com", reason: "bounced" },
    { email: "spam@flag.com", reason: "complained" },
  ]);
});

test("a dead webhook event pings ops (webhook_dead alert)", async () => {
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ('boom', $1, 'x', '{}')`,
    [randomUUID()],
  );
  const throwing = { boom: async () => { throw new Error("handler exploded"); } };
  await drainWebhooks({ handlers: throwing, maxAttempts: 1 });
  const alert = await pool.query<{ payload: { detail: string } }>(
    `select payload from notification_outbox where event_type = 'webhook_dead'`,
  );
  assert.equal(alert.rowCount, 1);
  assert.match(alert.rows[0]!.payload.detail, /handler exploded/);
});

test("payout settle enqueues ONE ticket_paid with a pt-BR summary; replayed status adds none", async () => {
  const orgId = await createOrg("active");
  const vendorRef = `tkt_${randomUUID()}`;
  await pool.query(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, dest_amount,
                                   provider_code, vendor_ref, idem_key, quote)
     values ($1, 'payout', 'executing', 'BRLA', 1000, 'BRL', 980, 'avenia', $2, $3, '{"ticketStatus":"PROCESSING"}')`,
    [orgId, vendorRef, randomUUID()],
  );
  await settleTicket(vendorRef);
  await settleTicket(vendorRef); // replay: monotonic guard -> ignore -> no second enqueue
  const { rows } = await rowsFor("event_type = 'ticket_settled' and recipient_ref = $1", [orgId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload.summary, "Pagamento de R$ 9,80 enviado.");
  // v2 receipt (PRD-14): settlement time always derivable from created_at
  assert.match((rows[0]!.payload as { receipt?: string }).receipt ?? "", /Liquidado em /);
});

test("failed ticket enqueues the neutral ticket_failed (no reason anywhere)", async () => {
  const orgId = await createOrg("active");
  const vendorRef = `tkt_${randomUUID()}`;
  await pool.query(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency,
                                   provider_code, vendor_ref, idem_key, quote)
     values ($1, 'convert_and_send', 'executing', 'BRLA', 1000, 'USDT', 'avenia', $2, $3, '{"ticketStatus":"PROCESSING"}')`,
    [orgId, vendorRef, randomUUID()],
  );
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ('avenia', $1, 'TICKET-FAILED', $2)`,
    [randomUUID(), JSON.stringify({ event: { id: randomUUID(), data: { type: "TICKET-FAILED", ticket: { id: vendorRef, status: "FAILED" } } } })],
  );
  await drainWebhooks();
  const { rows } = await rowsFor("event_type = 'ticket_failed' and recipient_ref = $1", [orgId]);
  assert.equal(rows.length, 1);
});

test("SLA sweep alerts once per breached org — dedupe survives a second sweep", async () => {
  const orgId = await createOrg("vendor_pending");
  await pool.query(
    `update orgs set admission_state = 'pending', kyb_forwarded_at = now() - interval '10 days' where id = $1`,
    [orgId],
  );
  assert.equal(await alertSlaBreachesOnce(2), 1);
  assert.equal(await alertSlaBreachesOnce(2), 0); // exists-dedupe on the outbox row
  const { rows } = await pool.query<{ payload: { detail: string } }>(
    `select payload from notification_outbox where event_type = 'sla_breach' and recipient_ref = $1`,
    [orgId],
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.payload.detail, /thresholdDays/);
});
