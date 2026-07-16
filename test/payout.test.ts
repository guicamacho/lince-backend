/** PIX payout (PRD-11): two-phase reservation under the org money lock, beneficiary forwarding,
 *  exactly-once 2-leg settle. Mirrors convert.test.ts — the reference money-out suite. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../src/db/pool.js";
import { createPayout, type PayoutClient } from "../src/modules/money/payout.js";
import { createConvert } from "../src/modules/money/convert.js";
import { reconcileInFlightTickets } from "../src/modules/money/moneyLoop.js";
import { registerPostRecoveryHold } from "../src/modules/access/recoveryHold.js";
import { ensureAccount, postBalancedTransactionOn, balancesForOrg } from "../src/modules/ledger/ledger.service.js";
import { drainWebhooks } from "../src/modules/webhooks/processor.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// A settled BRLA balance for an org (mirrors a deposit settle: custody +minor / org liability -minor).
async function seedBrla(orgId: string, minor: bigint): Promise<void> {
  await withTransaction(async (c) => {
    const custody = await ensureAccount(c, { key: `avenia:custody:BRLA`, type: "vendor_asset", currency: "BRLA" });
    const org = await ensureAccount(c, { key: `org:${orgId}:BRLA`, type: "customer_liability", orgId, currency: "BRLA" });
    await postBalancedTransactionOn(c, {
      description: "seed",
      postings: [
        { accountId: custody, amount: minor, currency: "BRLA" },
        { accountId: org, amount: -minor, currency: "BRLA" },
      ],
    });
  });
}

// A PIX payee in the address book, not yet forwarded to Avenia (avenia_beneficiary_id null).
async function createPixBeneficiary(orgId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into avenia_beneficiaries
       (org_id, label, rail, dest_currency, destination, dest_hint, payee_legal_name, payee_country,
        purpose_of_payment, status)
     values ($1, $2, $3, 'BRL', $4, '6c2c', 'Fornecedor Exemplo LTDA', 'BR', 'pagamento de fornecedor', $5)
     returning id`,
    [
      orgId,
      (overrides.label as string) ?? "Fornecedor Exemplo",
      (overrides.rail as string) ?? "pix",
      JSON.stringify((overrides.destination as object) ?? { pixKey: "3f2a8b1e-9c4d-4e7a-b6f0-1d2c3e4a5b6c", pixKeyType: "random" }),
      (overrides.status as string) ?? "active",
    ],
  );
  return rows[0]!.id;
}

// Fake Avenia: counts beneficiary registrations and payout tickets; PIX-out fee ~2% baked in.
function fakeClient() {
  let tickets = 0;
  let forwards = 0;
  const client: PayoutClient & { tickets: number; forwards: number } = {
    get tickets() { return tickets; },
    get forwards() { return forwards; },
    async createSubAccount() { return { id: `sub_${randomUUID().slice(0, 8)}` }; },
    async createBrlBeneficiary() {
      forwards++;
      return { id: `ben_${forwards}` };
    },
    async createPixPayout({ inputCurrency, inputAmount }) {
      tickets++;
      const out = (Number(inputAmount) * 0.98).toFixed(2);
      return {
        ticketId: `tkt_${tickets}`,
        quote: {
          inputCurrency, inputAmount, outputCurrency: "BRL", outputAmount: out,
          basePrice: "1", pairName: "BRLABRL",
          appliedFees: [{ type: "Out Fee", amount: (Number(inputAmount) * 0.02).toFixed(2), currency: inputCurrency, rebatable: true }],
        },
      };
    },
  } as never;
  return client;
}

async function settle(vendorRef: string): Promise<void> {
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ('avenia', $1, 'TICKET-PAID', $2)`,
    [randomUUID(), JSON.stringify({ event: { id: randomUUID(), data: { type: "TICKET-PAID", ticket: { id: vendorRef, status: "PAID" } } } })],
  );
  await drainWebhooks();
}

test("createPayout: reserves, forwards the payee, pays out, and settle posts a balanced 2-leg debit", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n); // R$100,00
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  const receipt = await createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey: randomUUID() }, client);
  assert.equal(receipt.state, "funding");
  assert.equal(receipt.sourceAmount, 5_000); // 50 BRLA in centavos
  assert.equal(receipt.destAmount, 4_900); // 49.00 BRL actually sent (fee baked in)
  assert.equal(receipt.beneficiaryId, benId);

  // The payee was forwarded to Avenia exactly once and the id persisted.
  assert.equal(client.forwards, 1);
  const ben = await pool.query<{ avenia_beneficiary_id: string }>(
    "select avenia_beneficiary_id from avenia_beneficiaries where id = $1", [benId]);
  assert.equal(ben.rows[0]!.avenia_beneficiary_id, "ben_1");

  await settle("tkt_1");
  const bal = await balancesForOrg(orgId);
  assert.equal(bal.BRLA, 5_000, "BRLA reduced by the full reserved amount");

  const audit = await pool.query(
    "select event from audit_log where org_id = $1 and event in ('payout.initiated','avenia.beneficiary_forwarded') order by event",
    [orgId]);
  assert.deepEqual(audit.rows.map((r) => r.event), ["avenia.beneficiary_forwarded", "payout.initiated"]);
});

test("second payout to the same payee reuses the stored Avenia beneficiary (no re-forward)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  await createPayout(orgId, null, { beneficiaryId: benId, amount: "20", idemKey: randomUUID() }, client);
  await createPayout(orgId, null, { beneficiaryId: benId, amount: "30", idemKey: randomUUID() }, client);
  assert.equal(client.forwards, 1, "forwarded exactly once");
  assert.equal(client.tickets, 2);
});

test("two concurrent payouts exceeding the balance: exactly one wins (money-lock reservation)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n); // R$100 — enough for one 60 but not two
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  const results = await Promise.allSettled([
    createPayout(orgId, null, { beneficiaryId: benId, amount: "60", idemKey: randomUUID() }, client),
    createPayout(orgId, null, { beneficiaryId: benId, amount: "60", idemKey: randomUUID() }, client),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "exactly one reservation succeeds");
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0]!.reason as Error).message ?? rejected[0]!.reason), /insufficient_balance/);
  assert.equal(client.tickets, 1, "only the winner calls Avenia");
});

test("concurrent convert + payout contend for the same balance: exactly one wins (cross-op)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  const payoutClient = fakeClient();
  const convertClient = {
    async createSubAccount() { return { id: "sub_x" }; },
    async getAccountInfo() { return {}; },
    async createSwap({ inputCurrency, outputCurrency, inputAmount }: { inputCurrency: string; outputCurrency: string; inputAmount: string }) {
      return {
        ticketId: "tkt_conv",
        quote: {
          inputCurrency, inputAmount, outputCurrency, outputAmount: (Number(inputAmount) / 5.2).toFixed(6),
          basePrice: "5.2", pairName: "USDTBRLA", appliedFees: [],
        },
      };
    },
  } as never;
  const results = await Promise.allSettled([
    createPayout(orgId, null, { beneficiaryId: benId, amount: "60", idemKey: randomUUID() }, payoutClient),
    createConvert(orgId, null, { from: "BRLA", to: "USDT", amount: "60", idemKey: randomUUID() }, convertClient),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "the two op types share one reservation pool");
  assert.match(String((rejected[0]!.reason as Error).message ?? rejected[0]!.reason), /insufficient_balance/);
});

test("same idemKey + same payload replays the SAME reservation (no double-payout)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  const idemKey = randomUUID();
  const a = await createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey }, client);
  const b = await createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey }, client);
  assert.equal(a.id, b.id);
  assert.equal(client.tickets, 1, "Avenia called exactly once");
});

test("same idemKey + DIFFERENT payload (other beneficiary) -> 409, no second ticket", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benA = await createPixBeneficiary(orgId);
  const benB = await createPixBeneficiary(orgId, { label: "Outro Fornecedor" });
  const client = fakeClient();
  const idemKey = randomUUID();
  await createPayout(orgId, null, { beneficiaryId: benA, amount: "50", idemKey }, client);
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benB, amount: "50", idemKey }, client),
    /idem_key_payload_mismatch/,
  );
  assert.equal(client.tickets, 1);
});

test("insufficient balance is rejected before any ticket, reservation rolled back", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 3_000n); // R$30
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey: randomUUID() }, client),
    /insufficient_balance/,
  );
  assert.equal(client.tickets, 0, "Avenia never called");
  assert.equal(client.forwards, 0, "payee never forwarded");
  const rows = await pool.query("select count(*)::int as n from org_transactions where org_id = $1", [orgId]);
  assert.equal(rows.rows[0]!.n, 0, "the reservation row was rolled back");
});

test("beneficiary gates: other org's payee 404, non-pix rail 422, disabled payee 422", async () => {
  const orgId = await createOrg("active");
  const otherOrg = await createOrg("active", "23456789000195");
  await seedBrla(orgId, 10_000n);
  const foreign = await createPixBeneficiary(otherOrg);
  const crypto = await createPixBeneficiary(orgId, { rail: "crypto", destination: { walletAddress: "0x" + "a".repeat(40) } });
  const disabled = await createPixBeneficiary(orgId, { status: "disabled" });
  const client = fakeClient();
  const pay = (beneficiaryId: string) =>
    createPayout(orgId, null, { beneficiaryId, amount: "10", idemKey: randomUUID() }, client);
  await assert.rejects(pay(foreign), /beneficiary_not_found/);
  await assert.rejects(pay(crypto), /unsupported_rail/);
  await assert.rejects(pay(disabled), /beneficiary_disabled/);
  assert.equal(client.tickets, 0);
});

test("24h post-recovery hold blocks money-out before any reservation", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  await registerPostRecoveryHold(orgId, 24);
  const client = fakeClient();
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey: randomUUID() }, client),
    /money_out_held/,
  );
  assert.equal(client.tickets, 0);
  const rows = await pool.query("select count(*)::int as n from org_transactions where org_id = $1", [orgId]);
  assert.equal(rows.rows[0]!.n, 0, "no reservation was ever created");
});

// A client whose createPixPayout creates the ticket at Avenia and THEN throws (lost response). It
// also answers findTicketByExternalId with the executed ticket — the money-loss-recovery scenario.
function lostResponseClient(ticketExists: boolean) {
  const byExternal = new Map<string, { id: string; outputAmount: string }>();
  let n = 0;
  return {
    async createSubAccount() { return { id: "sub_lost" }; },
    async createBrlBeneficiary() { return { id: "ben_lost" }; },
    async createPixPayout({ inputAmount, externalId }: { inputAmount: string; externalId?: string }) {
      n++;
      if (ticketExists && externalId) byExternal.set(externalId, { id: `tkt_${n}`, outputAmount: (Number(inputAmount) * 0.98).toFixed(2) });
      throw new Error("connection reset after ticket POST"); // response lost after the payout executed
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

test("Phase-2 lost response leaves the row RECOVERABLE ('created'), and the reconciler settles the real payout (no money loss)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  const client = lostResponseClient(true); // same instance "remembers" the ticket it created
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey: randomUUID() }, client),
    /payout_pending_reconcile/,
  );
  // NOT 'failed' — the payout may have executed, so the row must stay reconcilable.
  const row = await pool.query<{ state: string }>("select state from org_transactions where org_id = $1", [orgId]);
  assert.equal(row.rows[0]!.state, "created");

  await ageRow(orgId);
  const applied = await reconcileInFlightTickets(client as never, 30);
  assert.equal(applied, 1, "reconciler recovered and settled the executed payout");
  const bal = await balancesForOrg(orgId);
  assert.equal(bal.BRLA, 5_000, "the executed payout was debited, not lost");
});

test("Phase-2 failure with NO ticket at Avenia is released by the reconciler (reservation freed)", async () => {
  const orgId = await createOrg("active");
  await seedBrla(orgId, 10_000n);
  const benId = await createPixBeneficiary(orgId);
  const client = lostResponseClient(false); // no ticket ever created at Avenia
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "50", idemKey: randomUUID() }, client),
    /payout_pending_reconcile/,
  );
  await ageRow(orgId);
  await reconcileInFlightTickets(client as never, 30);
  const row = await pool.query<{ state: string }>("select state from org_transactions where org_id = $1", [orgId]);
  assert.equal(row.rows[0]!.state, "failed", "no ticket existed -> reservation released");
  // Balance never moved, and the full amount is payable again.
  const ok = await createPayout(orgId, null, { beneficiaryId: benId, amount: "100", idemKey: randomUUID() }, fakeClient());
  assert.equal(ok.state, "funding");
});

test("invalid amount is a 422 before any DB work", async () => {
  const orgId = await createOrg("active");
  const benId = await createPixBeneficiary(orgId);
  const client = fakeClient();
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "50.123", idemKey: randomUUID() }, client),
    /invalid_amount/,
  );
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: benId, amount: "-5", idemKey: randomUUID() }, client),
    /invalid_amount/,
  );
});
