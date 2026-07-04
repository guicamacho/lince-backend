/**
 * Notification outbox — service level against lince_test.
 *
 * SELF-CONTAINED by design: Agent A's suite hits the same lince_test concurrently, so
 * this file NEVER truncates shared tables. Rows are tagged with an "obtest:" recipient_ref
 * prefix and cleaned by that prefix only; assertions are scoped to specific row ids so a
 * global drain of stray rows can't affect them. Each DB test retries once on a transient
 * collision (e.g. another suite truncating mid-test).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../src/db/pool.js";
import { enqueueNotification, drainOutboxOnce, MAX_ATTEMPTS } from "../src/modules/notifications/outbox.js";
import type { NotifyConfig, SendAdapter } from "../src/modules/notifications/adapters.js";

const cfg: NotifyConfig = { emailAdapter: "log" }; // LogAdapter for every class — never networks

const uniq = () => `obtest:${randomUUID()}`;
const cleanup = () => pool.query("delete from notification_outbox where recipient_ref like 'obtest:%'");

beforeEach(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

// ponytail: retry once on a transient collision with a concurrent suite (task requirement).
async function retry1(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    await cleanup();
    await fn();
  }
}

async function enqueueOne(recipientRef: string, templateId: "activation_approved" | "returned_to_complete"): Promise<string> {
  return withTransaction(async (client) => {
    await enqueueNotification(client, { eventType: templateId, recipientRef, templateId, payload: { label: "X" } });
    const { rows } = await client.query<{ id: string }>(
      "select id from notification_outbox where recipient_ref = $1",
      [recipientRef],
    );
    return rows[0]!.id;
  });
}

async function statusOf(id: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; sent_at: string | null; audit_ref: string | null }>(
    "select status, attempts, sent_at, audit_ref from notification_outbox where id = $1",
    [id],
  );
  return rows[0]!;
}

const failing: SendAdapter = { async send() { return { ok: false, error: "boom" }; } };
const mustNotSend: SendAdapter = { async send() { throw new Error("must not send"); } };

test("acceptance #1 — a rolled-back tx leaves zero outbox rows", async () => {
  await retry1(async () => {
    const rref = uniq();
    await assert.rejects(
      withTransaction(async (client) => {
        await enqueueNotification(client, { eventType: "x", recipientRef: rref, templateId: "activation_approved" });
        throw new Error("rollback");
      }),
    );
    const { rowCount } = await pool.query("select 1 from notification_outbox where recipient_ref = $1", [rref]);
    assert.equal(rowCount, 0);
  });
});

test("acceptance #4 — successful send marks sent and writes a system audit_log ref", async () => {
  await retry1(async () => {
    const id = await enqueueOne(uniq(), "activation_approved");
    await drainOutboxOnce(cfg); // default selectAdapter => LogAdapter, no network
    const row = await statusOf(id);
    assert.equal(row.status, "sent");
    assert.ok(row.sent_at, "sent_at set");
    assert.ok(row.audit_ref, "audit_ref set");
    const audit = await pool.query<{ event: string; actor_type: string; payload: { outboxId: string } }>(
      "select event, actor_type, payload from audit_log where id = $1",
      [row.audit_ref],
    );
    assert.equal(audit.rows[0]!.event, "notification.sent");
    assert.equal(audit.rows[0]!.actor_type, "system");
    assert.equal(audit.rows[0]!.payload.outboxId, id);
  });
});

test("acceptance #2 — a failing adapter retries then dead-letters; sibling rows not blocked", async () => {
  await retry1(async () => {
    const idA = await enqueueOne(uniq(), "activation_approved");
    const idB = await enqueueOne(uniq(), "activation_approved");

    await drainOutboxOnce(cfg, () => failing); // one tick
    const a1 = await statusOf(idA);
    const b1 = await statusOf(idB);
    assert.equal(a1.status, "failed");
    assert.equal(a1.attempts, 1);
    assert.equal(b1.status, "failed"); // sibling advanced too — not blocked by A
    assert.equal(b1.attempts, 1);

    for (let i = 1; i < MAX_ATTEMPTS; i++) await drainOutboxOnce(cfg, () => failing);
    const aDead = await statusOf(idA);
    assert.equal(aDead.status, "dead");
    assert.equal(aDead.attempts, MAX_ATTEMPTS);
  });
});

test("acceptance #3 — an unreviewed customer template is refused (dead) and never sent", async () => {
  await retry1(async () => {
    const id = await enqueueOne(uniq(), "returned_to_complete"); // tipping_off_reviewed:false
    await drainOutboxOnce(cfg, () => mustNotSend); // adapter throws if reached
    const row = await statusOf(id);
    assert.equal(row.status, "dead");
    assert.equal(row.attempts, 0); // refused before any send attempt
  });
});
