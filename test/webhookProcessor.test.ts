/** Webhook drain: retry accounting, dead-lettering, poison isolation, replay, and receipt dedupe. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { drainWebhooks, replayWebhookEvent, type WebhookHandler } from "../src/modules/webhooks/processor.js";
import { receiveWebhook } from "../src/modules/webhooks/inbox.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

async function insertEvent(provider: string, externalId: string, type = "t"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
       values ($1, $2, $3, '{}') returning id`,
    [provider, externalId, type],
  );
  return rows[0]!.id;
}

async function statusOf(id: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
    "select status, attempts, last_error from webhook_events where id = $1",
    [id],
  );
  return rows[0]!;
}

test("failing handler retries then dead-letters; the poison row never blocks others", async () => {
  const bad = await insertEvent("avenia", "evt-bad");
  const good = await insertEvent("avenia", "evt-good");
  const handlers: Record<string, WebhookHandler> = {
    avenia: async (_c, row) => {
      if (row.external_event_id === "evt-bad") throw new Error("boom");
    },
  };

  await drainWebhooks({ handlers, maxAttempts: 3 });
  let bs = await statusOf(bad);
  assert.equal(bs.status, "failed");
  assert.equal(bs.attempts, 1);
  assert.match(bs.last_error ?? "", /boom/);
  assert.equal((await statusOf(good)).status, "processed"); // unblocked on the same drain

  await drainWebhooks({ handlers, maxAttempts: 3 });
  await drainWebhooks({ handlers, maxAttempts: 3 });
  bs = await statusOf(bad);
  assert.equal(bs.status, "dead");
  assert.equal(bs.attempts, 3);

  // dead rows are no longer claimed
  await drainWebhooks({ handlers, maxAttempts: 3 });
  assert.equal((await statusOf(bad)).attempts, 3);
});

test("a handler whose SQL errors still dead-letters and never rolls back siblings", async () => {
  const bad = await insertEvent("avenia", "evt-sqlbad");
  const good = await insertEvent("avenia", "evt-sqlgood");
  const handlers: Record<string, WebhookHandler> = {
    avenia: async (c, row) => {
      // A real Postgres error (not a JS throw): absent the per-row savepoint this aborts the
      // shared batch transaction and defeats dead-lettering entirely.
      if (row.external_event_id === "evt-sqlbad") await c.query("select 1/0");
    },
  };

  await drainWebhooks({ handlers, maxAttempts: 2 });
  let bs = await statusOf(bad);
  assert.equal(bs.status, "failed");
  assert.equal(bs.attempts, 1);
  assert.match(bs.last_error ?? "", /division by zero/);
  assert.equal((await statusOf(good)).status, "processed"); // sibling committed despite the SQL abort

  await drainWebhooks({ handlers, maxAttempts: 2 });
  bs = await statusOf(bad);
  assert.equal(bs.status, "dead");
  assert.equal(bs.attempts, 2);
});

test("replay resets a dead row so the drain re-picks and processes it", async () => {
  const id = await insertEvent("avenia", "evt-x");
  const failing: Record<string, WebhookHandler> = { avenia: async () => { throw new Error("nope"); } };

  await drainWebhooks({ handlers: failing, maxAttempts: 1 });
  assert.equal((await statusOf(id)).status, "dead");

  await replayWebhookEvent(id);
  const reset = await statusOf(id);
  assert.equal(reset.status, "received");
  assert.equal(reset.attempts, 0);
  assert.equal(reset.last_error, null);

  await drainWebhooks({ handlers: {}, maxAttempts: 1 }); // no-op handler => success
  assert.equal((await statusOf(id)).status, "processed");
});

test("receiveWebhook dedupes on (provider, external_event_id)", async () => {
  // didit = still store-only (scheme unconfirmed); avenia is signature-verified since the
  // PSS scheme landed, so it no longer works as the store-only example here.
  const input = {
    provider: "didit",
    externalId: "dup-1",
    eventType: "verification.updated",
    rawBody: "{}",
    payload: { id: "dup-1" },
    headers: {},
    config: {},
  };
  assert.equal((await receiveWebhook(input)).status, 202);
  assert.equal((await receiveWebhook(input)).status, 202);
  const { rowCount } = await pool.query(
    "select 1 from webhook_events where provider_code = 'didit' and external_event_id = 'dup-1'",
  );
  assert.equal(rowCount, 1);
});

test("receiveWebhook rejects an unknown provider (404) and stores NOTHING (anti-DoS)", async () => {
  const res = await receiveWebhook({
    provider: "attacker",
    externalId: "x", eventType: "x", rawBody: "{}", payload: { big: "x".repeat(1000) }, headers: {}, config: {},
  });
  assert.equal(res.status, 404);
  const { rowCount } = await pool.query("select 1 from webhook_events where provider_code = 'attacker'");
  assert.equal(rowCount, 0);
});

test("receiveWebhook rejects an unverified Svix provider with 400 and stores nothing", async () => {
  const res = await receiveWebhook({
    provider: "clerk",
    externalId: "c1",
    eventType: "user.created",
    rawBody: '{"type":"user.created"}',
    payload: { type: "user.created" },
    headers: { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,deadbeef" },
    config: { clerkSecret: "whsec_" + Buffer.from("shhh-not-the-real-key").toString("base64") },
  });
  assert.equal(res.status, 400);
  const { rowCount } = await pool.query("select 1 from webhook_events where provider_code = 'clerk'");
  assert.equal(rowCount, 0);
});

test("receiveWebhook returns 503 when a Svix provider is unconfigured", async () => {
  const res = await receiveWebhook({
    provider: "clerk",
    externalId: "c2",
    eventType: "user.created",
    rawBody: "{}",
    payload: {},
    headers: {},
    config: {},
  });
  assert.equal(res.status, 503);
});
