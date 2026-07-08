/** PIX deposits: idempotency payload binding (PRD-07 p5) + webhook state application. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { createDeposit, reconcileInFlightDeposits, type DepositClient } from "../src/modules/money/deposits.js";
import { drainWebhooks } from "../src/modules/webhooks/processor.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

function fakeClient(behavior: "ok" | "fail" = "ok") {
  let tickets = 0;
  const client: DepositClient & { tickets: number } = {
    get tickets() { return tickets; },
    async createSubAccount() { return { id: `sub_${randomUUID().slice(0, 8)}` }; },
    async getAccountInfo() { return {}; },
    async createPixDeposit({ amountBrl }) {
      if (behavior === "fail") throw new Error("avenia down");
      tickets++;
      return {
        ticketId: `tkt_${tickets}`,
        brCode: "00020126...",
        expiration: "2026-07-10T00:00:00Z",
        quote: {
          inputCurrency: "BRL", inputAmount: amountBrl, outputCurrency: "BRLA",
          outputAmount: (Number(amountBrl) - 0.2).toFixed(2), basePrice: "1", pairName: "BRLBRLA",
          appliedFees: [{ type: "In Fee", amount: "0.2", currency: "BRL", rebatable: true }],
        },
      };
    },
  } as never;
  return client;
}

async function insertAveniaEvent(vendorRef: string, status: string): Promise<void> {
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ('avenia', $1, $2, $3)`,
    [randomUUID(), `TICKET-${status}`, JSON.stringify({ event: { id: randomUUID(), data: { type: `TICKET-${status}`, ticket: { id: vendorRef, status } } } })],
  );
}

test("createDeposit: claims row, creates ticket, returns brCode + actual amounts", async () => {
  const orgId = await createOrg("active");
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, fakeClient());
  assert.equal(receipt.state, "funding");
  assert.equal(receipt.brCode, "00020126...");
  assert.equal(receipt.sourceAmount, 10000); // centavos
  assert.equal(receipt.destAmount, 9980);
  assert.equal(receipt.fees[0]!.amount, 20);
  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'deposit.initiated'", [orgId]);
  assert.equal(audit.rowCount, 1);
});

test("pattern 5: same idemKey + same payload replays the SAME ticket (no double-create)", async () => {
  const orgId = await createOrg("active");
  const client = fakeClient();
  const idemKey = randomUUID();
  const a = await createDeposit(orgId, null, { amountBrl: "100", idemKey }, client);
  const b = await createDeposit(orgId, null, { amountBrl: "100", idemKey }, client);
  assert.equal(a.id, b.id);
  assert.equal(client.tickets, 1, "Avenia called exactly once");
});

test("pattern 5: same idemKey + DIFFERENT payload -> 409, no second ticket", async () => {
  const orgId = await createOrg("active");
  const client = fakeClient();
  const idemKey = randomUUID();
  await createDeposit(orgId, null, { amountBrl: "100", idemKey }, client);
  await assert.rejects(
    () => createDeposit(orgId, null, { amountBrl: "999999", idemKey }, client),
    /idem_key_payload_mismatch/,
  );
  assert.equal(client.tickets, 1);
});

test("Avenia failure marks the row failed and surfaces 502", async () => {
  const orgId = await createOrg("active");
  await assert.rejects(
    () => createDeposit(orgId, null, { amountBrl: "50", idemKey: randomUUID() }, fakeClient("fail")),
    /deposit_unavailable/,
  );
  const { rows } = await pool.query("select state, error from org_transactions where org_id = $1", [orgId]);
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[0].error.stage, "create");
});

test("webhook TICKET events drive state forward, idempotently and monotonically", async () => {
  const orgId = await createOrg("active");
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, fakeClient());

  // PAID arrives (skipping PROCESSING — out-of-order tolerant), then a late PROCESSING replay.
  await insertAveniaEvent("tkt_1", "PAID");
  await drainWebhooks();
  let row = await pool.query("select state, quote->>'ticketStatus' as ts from org_transactions where id = $1", [receipt.id]);
  assert.equal(row.rows[0].state, "settled");
  assert.equal(row.rows[0].ts, "PAID");

  await insertAveniaEvent("tkt_1", "PROCESSING"); // late + lower rank -> ignored
  await insertAveniaEvent("tkt_1", "PAID"); // replay -> ignored
  await drainWebhooks();
  row = await pool.query("select state from org_transactions where id = $1", [receipt.id]);
  assert.equal(row.rows[0].state, "settled", "terminal state never regresses");
});

test("hyphenated wire statuses normalize (PARTIAL-FAILED -> failed)", async () => {
  const orgId = await createOrg("active");
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, fakeClient());
  await insertAveniaEvent("tkt_1", "PARTIAL-FAILED");
  await drainWebhooks();
  const { rows } = await pool.query("select state from org_transactions where id = $1", [receipt.id]);
  assert.equal(rows[0].state, "failed");
  void orgId;
});

test("events for unknown tickets (master/faucet) are ignored without error", async () => {
  await insertAveniaEvent("some-foreign-ticket", "PAID");
  await drainWebhooks();
  const { rows } = await pool.query("select status from webhook_events");
  assert.equal(rows[0].status, "processed");
});

test("reconciler settles a quiet in-flight deposit when webhooks never arrive", async () => {
  const orgId = await createOrg("active");
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, fakeClient());
  // age the row past the quiet window (webhooks would normally win inside it)
  await pool.query("update org_transactions set updated_at = now() - interval '10 minutes' where id = $1", [receipt.id]);
  const rail = { async getTicket() { return { id: "tkt_1", status: "PAID" }; } };
  const applied = await reconcileInFlightDeposits(rail, 45, 10);
  assert.equal(applied, 1);
  const { rows } = await pool.query("select state, quote->>'ticketStatus' as ts from org_transactions where id = $1", [receipt.id]);
  assert.equal(rows[0].state, "settled");
  assert.equal(rows[0].ts, "PAID");
  // second pass: nothing left in flight
  assert.equal(await reconcileInFlightDeposits(rail, 45, 10), 0);
});
