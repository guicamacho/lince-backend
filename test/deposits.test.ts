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

test("settle writes balanced ledger postings from ticket actuals — exactly once", async () => {
  const { balancesForOrg } = await import("../src/modules/ledger/ledger.service.js");
  const orgId = await createOrg("active");
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, fakeClient());

  await insertAveniaEvent("tkt_1", "PAID");
  await drainWebhooks();
  // customer sees +99.80 BRLA (net of the 0.20 In Fee), from the ticket's actual outputAmount
  assert.deepEqual(await balancesForOrg(orgId), { BRLA: 9980 });
  const postings = await pool.query(
    `select p.amount::text, a.key from ledger_postings p join ledger_accounts a on a.id = p.account_id
      join ledger_transactions t on t.id = p.ledger_tx_id where t.org_transaction_id = $1 order by p.amount desc`,
    [receipt.id],
  );
  assert.equal(postings.rowCount, 2);
  assert.equal(postings.rows[0].amount, "9980"); // debit avenia custody
  assert.equal(postings.rows[0].key, "avenia:custody:BRLA");
  assert.equal(postings.rows[1].amount, "-9980"); // credit org liability
  // PAID replay must NOT double-post
  await insertAveniaEvent("tkt_1", "PAID");
  await drainWebhooks();
  assert.deepEqual(await balancesForOrg(orgId), { BRLA: 9980 });
  const again = await pool.query("select count(*)::int as n from ledger_postings");
  assert.equal(again.rows[0].n, 2, "replay posts nothing");
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
  const rail = { async getTicket() { return { id: "tkt_1", status: "PAID" }; }, async findTicketByExternalId() { return null; } };
  const applied = await reconcileInFlightDeposits(rail, 45, 10);
  assert.equal(applied, 1);
  const { rows } = await pool.query("select state, quote->>'ticketStatus' as ts from org_transactions where id = $1", [receipt.id]);
  assert.equal(rows[0].state, "settled");
  assert.equal(rows[0].ts, "PAID");
  // second pass: nothing left in flight
  assert.equal(await reconcileInFlightDeposits(rail, 45, 10), 0);
});

test("invalid amountBrl -> 422 before any ticket/DB work", async () => {
  const orgId = await createOrg("active");
  const client = fakeClient();
  for (const bad of ["1e9", "", "0", "100.123", "  ", "0x10", "-5"]) {
    await assert.rejects(
      () => createDeposit(orgId, null, { amountBrl: bad, idemKey: randomUUID() }, client),
      /invalid_amount/,
      `expected 422 for ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(client.tickets, 0, "no Avenia ticket created for any invalid amount");
});

test("Avenia outputAmount with >2dp does not throw — deposit settles with rounded dest_amount", async () => {
  const orgId = await createOrg("active");
  // client returns a 3-decimal BRLA outputAmount (the old toMinor would have thrown here)
  const client = {
    async createSubAccount() { return { id: "sub_x" }; },
    async getAccountInfo() { return {}; },
    async createPixDeposit({ amountBrl }: { amountBrl: string }) {
      return {
        ticketId: "tkt_r", brCode: "00020126...", expiration: "",
        quote: { inputCurrency: "BRL", inputAmount: amountBrl, outputCurrency: "BRLA",
          outputAmount: "99.808", basePrice: "1", pairName: "BRLBRLA",
          appliedFees: [{ type: "In Fee", amount: "0.015", currency: "BRL", rebatable: true }] },
      };
    },
  } as unknown as DepositClient;
  const receipt = await createDeposit(orgId, null, { amountBrl: "100", idemKey: randomUUID() }, client);
  assert.equal(receipt.state, "funding");
  assert.equal(receipt.destAmount, 9981); // 99.808 -> 99.81 rounded to 2dp
  assert.equal(receipt.fees[0]!.amount, 2); // 0.015 -> 0.02
});

test("reconciler recovers a crash-orphan ('created', null vendor_ref) via externalId", async () => {
  const orgId = await createOrg("active");
  // simulate the crash window: a claim row that never got its vendor_ref persisted.
  const idemKey = randomUUID();
  await pool.query("insert into avenia_accounts (org_id, subaccount_id) values ($1, 'sub_o')", [orgId]);
  const ins = await pool.query<{ id: string }>(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, provider_code, idem_key)
     values ($1,'deposit','created','BRL',10000,'BRLA','avenia',$2) returning id`,
    [orgId, idemKey],
  );
  await pool.query("update org_transactions set updated_at = now() - interval '10 minutes' where id = $1", [ins.rows[0]!.id]);
  const rail = {
    async getTicket() { throw new Error("should not be called for a null vendor_ref row"); },
    async findTicketByExternalId({ externalId }: { externalId: string }) {
      assert.equal(externalId, idemKey);
      return { id: "tkt_recovered", status: "PAID", outputAmount: "99.80" };
    },
  };
  const applied = await reconcileInFlightDeposits(rail, 45, 10);
  assert.equal(applied, 1);
  const { rows } = await pool.query("select state, vendor_ref, dest_amount from org_transactions where id = $1", [ins.rows[0]!.id]);
  assert.equal(rows[0].vendor_ref, "tkt_recovered");
  assert.equal(rows[0].dest_amount, "9980");
  assert.equal(rows[0].state, "settled");
});
