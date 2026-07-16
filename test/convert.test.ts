/** Convert (PRD-10): two-phase reservation under the org money lock, exactly-once 4-leg settle. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { createConvert, type ConvertClient } from "../src/modules/money/convert.js";
import { reconcileInFlightTickets } from "../src/modules/money/moneyLoop.js";
import { balancesForOrg } from "../src/modules/ledger/ledger.service.js";
import { resetDb, createOrg, seedBalance, settleTicket } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const seedBrla = (orgId: string, minor: bigint) => seedBalance(orgId, "BRLA", minor);
const settle = settleTicket;

function fakeClient() {
  let tickets = 0;
  const client: ConvertClient & { tickets: number } = {
    get tickets() { return tickets; },
    async createSubAccount() { return { id: `sub_${randomUUID().slice(0, 8)}` }; },
    async getAccountInfo() { return {}; },
    async createSwap({ inputCurrency, outputCurrency, inputAmount }) {
      tickets++;
      // ~5.2 BRL/USD: 50 BRLA -> 9.62 USDT.
      const out = (Number(inputAmount) / 5.2).toFixed(6);
      return {
        ticketId: `tkt_${tickets}`,
        quote: {
          inputCurrency, inputAmount, outputCurrency, outputAmount: out,
          basePrice: "5.2", pairName: "USDTBRLA",
          appliedFees: [{ type: "Markup Fee", amount: "0", currency: inputCurrency, rebatable: false }],
        },
      };
    },
  } as never;
  return client;
}

test("createConvert: reserves, swaps, and settle posts a balanced 4-leg entry", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n); // R$100,00
  const receipt = await createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey: randomUUID() }, fakeClient());
  assert.equal(receipt.state, "funding");
  assert.equal(receipt.sourceAmount, 5_000); // 50 BRLA in centavos
  assert.equal(receipt.destAmount, 9_615_385); // 9.615385 USDT (6dp)

  await settle("tkt_1");
  const bal = await balancesForOrg(orgId);
  assert.equal(bal.BRLA, 5_000, "BRLA reduced by the converted amount");
  assert.equal(bal.USDT, 9_615_385, "USDT credited the swap output");

  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'convert.initiated'", [orgId]);
  assert.equal(audit.rowCount, 1);
});

test("two concurrent converts exceeding the balance: exactly one wins (money-lock reservation)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n); // R$100 — enough for one 60 but not two
  const client = fakeClient();
  const results = await Promise.allSettled([
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "60", idemKey: randomUUID() }, client),
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "60", idemKey: randomUUID() }, client),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "exactly one reservation succeeds");
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0]!.reason as Error).message ?? rejected[0]!.reason), /insufficient_balance/);
  assert.equal(client.tickets, 1, "only the winner calls Avenia");
});

test("insufficient balance is rejected before any ticket, reservation rolled back", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 3_000n); // R$30
  const client = fakeClient();
  await assert.rejects(
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey: randomUUID() }, client),
    /insufficient_balance/,
  );
  assert.equal(client.tickets, 0, "Avenia never called");
  const rows = await pool.query("select count(*)::int as n from org_transactions where org_id = $1", [orgId]);
  assert.equal(rows.rows[0]!.n, 0, "the reservation row was rolled back");
});

test("same idemKey + same payload replays the SAME reservation (no double-swap)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const client = fakeClient();
  const idemKey = randomUUID();
  const a = await createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey }, client);
  const b = await createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey }, client);
  assert.equal(a.id, b.id);
  assert.equal(client.tickets, 1, "Avenia called exactly once");
});

// A client whose createSwap creates the ticket at Avenia and THEN throws (lost response). It also
// answers findTicketByExternalId with the executed ticket — the money-loss-recovery scenario.
function lostResponseClient(ticketExists: boolean) {
  const byExternal = new Map<string, { id: string; outputAmount: string }>();
  let n = 0;
  return {
    async createSubAccount() { return { id: "sub_lost" }; },
    async getAccountInfo() { return {}; },
    async createSwap({ inputAmount, externalId }: { inputAmount: string; externalId?: string }) {
      n++;
      if (ticketExists && externalId) byExternal.set(externalId, { id: `tkt_${n}`, outputAmount: (Number(inputAmount) / 5.2).toFixed(6) });
      throw new Error("connection reset after ticket POST"); // response lost after the swap executed
    },
    async getTicket() { return null as never; },
    async findTicketByExternalId({ externalId }: { externalId: string }) {
      const t = byExternal.get(externalId);
      return t ? { id: t.id, status: "PAID", outputAmount: t.outputAmount } : null;
    },
  } as never;
}

async function ageRow(orgId: string): Promise<void> {
  await pool.query("update org_transactions set updated_at = now() - interval '2 minutes' where org_id = $1", [orgId]);
}

test("Phase-2 lost response leaves the row RECOVERABLE ('created'), and the reconciler settles the real swap (no money loss)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const client = lostResponseClient(true); // same instance "remembers" the ticket it created
  await assert.rejects(
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey: randomUUID() }, client),
    /convert_pending_reconcile/,
  );
  // NOT 'failed' — the swap may have executed, so the row must stay reconcilable.
  const row = await pool.query<{ state: string }>("select state from org_transactions where org_id = $1", [orgId]);
  assert.equal(row.rows[0]!.state, "created");

  await ageRow(orgId);
  const applied = await reconcileInFlightTickets(client as never, 30);
  assert.equal(applied, 1, "reconciler recovered and settled the executed swap");
  const bal = await balancesForOrg(orgId);
  assert.equal(bal.BRLA, 5_000);
  assert.equal(bal.USDT, 9_615_385); // recovered, not lost
});

test("Phase-2 failure with NO ticket at Avenia is released by the reconciler (reservation freed)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const client = lostResponseClient(false); // no ticket ever created at Avenia
  await assert.rejects(
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "50", idemKey: randomUUID() }, client),
    /convert_pending_reconcile/,
  );
  await ageRow(orgId);
  await reconcileInFlightTickets(client as never, 30);
  const row = await pool.query<{ state: string }>("select state from org_transactions where org_id = $1", [orgId]);
  assert.equal(row.rows[0]!.state, "failed", "no ticket existed -> reservation released");
  // Balance never moved, and the full amount is convertible again.
  const ok = await createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "100", idemKey: randomUUID() }, fakeClient());
  assert.equal(ok.state, "funding");
});

test("unsupported pair is a 422 before any DB work", async () => {
  const orgId = await createOrg("active");
  await assert.rejects(
    createConvert(orgId, null, { from: "BRLA", to: "BRL", amount: "50", idemKey: randomUUID() }, fakeClient()),
    /unsupported_pair/,
  );
});
