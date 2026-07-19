/** The small-gaps tail batch: §13.2 change control, dispute intake, PRD-01/07 smalls. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import {
  createBeneficiaryForOrg, updateBeneficiaryForOrg, verifyBeneficiary, listPendingReverification,
  ensureAveniaBeneficiary,
} from "../src/modules/beneficiaries/beneficiaries.service.js";
import { createPayout } from "../src/modules/money/payout.js";
import { createDisputeForOrg } from "../src/modules/cases/customerInbox.service.js";
import { listCases } from "../src/modules/cases/cases.service.js";
import { postAdminCaseMessage } from "../src/modules/cases/messages.service.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { MockKybProvider } from "../src/modules/providers/didit/mock.kyb.js";
import { setOrgAccess } from "../src/modules/access/access.service.js";
import { receiveWebhook } from "../src/modules/webhooks/inbox.js";
import { HttpError } from "../src/http/error.js";
import { resetDb, createOrg, createAdmin, seedBalance } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const pixBody = () => ({
  label: "Fornecedor BR",
  rail: "pix",
  payeeLegalName: "Fornecedor Ltda",
  purposeOfPayment: "fatura",
  destination: { pixKey: "11122233344", pixKeyType: "cpf" },
});

test("§13.2: create is born-verified; label-only edit never resets; destination edit does everything", async () => {
  const orgId = await createOrg("active");
  const { id } = await createBeneficiaryForOrg(orgId, null, pixBody());
  const created = await pool.query(
    "select verification_status, verified_at, destination_kind, avenia_beneficiary_id from avenia_beneficiaries where id = $1",
    [id],
  );
  assert.equal(created.rows[0].verification_status, "verified", "born-active ruling: created payees are verified");
  assert.ok(created.rows[0].verified_at);
  assert.equal(created.rows[0].destination_kind, "pix_key");

  // Simulate a previously forwarded vendor-side record — a destination change must orphan it.
  await pool.query("update avenia_beneficiaries set avenia_beneficiary_id = 'ben_stale' where id = $1", [id]);

  // Label-only: no reset, no email, audited as a plain update.
  const labelOnly = await updateBeneficiaryForOrg(orgId, null, id, { label: "Fornecedor Novo Nome" });
  assert.equal(labelOnly.verificationStatus, "verified");
  const afterLabel = await pool.query(
    "select label, verification_status, avenia_beneficiary_id from avenia_beneficiaries where id = $1", [id],
  );
  assert.equal(afterLabel.rows[0].label, "Fornecedor Novo Nome");
  assert.equal(afterLabel.rows[0].verification_status, "verified");
  assert.equal(afterLabel.rows[0].avenia_beneficiary_id, "ben_stale", "label edits keep the vendor record");

  // Destination change: changed_pending + stamped + vendor record CLEARED + masked diff + email.
  const changed = await updateBeneficiaryForOrg(orgId, null, id, {
    destination: { pixKey: "99988877766", pixKeyType: "cpf" },
  });
  assert.equal(changed.verificationStatus, "changed_pending");
  const after = await pool.query(
    `select verification_status, destination_changed_at, verified_at, avenia_beneficiary_id,
            dest_hint, destination from avenia_beneficiaries where id = $1`, [id],
  );
  assert.equal(after.rows[0].verification_status, "changed_pending");
  assert.ok(after.rows[0].destination_changed_at);
  assert.equal(after.rows[0].verified_at, null);
  assert.equal(after.rows[0].avenia_beneficiary_id, null, "stale vendor-side record orphaned");
  assert.equal(after.rows[0].destination.pixKey, "99988877766");

  const audit = await pool.query<{ payload: Record<string, unknown> }>(
    "select payload from audit_log where org_id = $1 and event = 'beneficiary.destination_changed'", [orgId],
  );
  assert.equal(audit.rows.length, 1);
  const payload = JSON.stringify(audit.rows[0]!.payload);
  assert.ok(!payload.includes("99988877766") && !payload.includes("11122233344"), "audit diff is MASKED");
  assert.equal(audit.rows[0]!.payload.newHint, after.rows[0].dest_hint);

  const mail = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'beneficiary_destination_changed' and recipient_ref = $1",
    [orgId],
  );
  assert.equal(mail.rows[0]!.n, 1);
});

test("§13.2: changed_pending is NOT payable; admin verify makes it payable and notifies", async () => {
  const orgId = await createOrg("active");
  await seedBalance(orgId, "BRLA", 10_000n);
  const { id } = await createBeneficiaryForOrg(orgId, null, pixBody());
  await updateBeneficiaryForOrg(orgId, null, id, { destination: { pixKey: "55544433322", pixKeyType: "cpf" } });

  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: id, amount: "10", idemKey: randomUUID() }, {} as never),
    /beneficiary_reverification_pending/,
  );

  const queue = await listPendingReverification();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, id);

  const admin = await createAdmin();
  assert.equal(await verifyBeneficiary(id, admin), true);
  assert.equal(await verifyBeneficiary(id, admin), false, "second verify is a 409 (not pending)");
  const row = await pool.query("select verification_status, verified_at from avenia_beneficiaries where id = $1", [id]);
  assert.equal(row.rows[0].verification_status, "verified");
  assert.ok(row.rows[0].verified_at);
  const mail = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'beneficiary_verified'",
  );
  assert.equal(mail.rows[0]!.n, 1);
});

test("dispute intake: case + ack ONCE per transaction; appends reuse the case; SLA timer via listCases", async () => {
  const orgId = await createOrg("active");
  const tx = await pool.query<{ id: string }>(
    `insert into org_transactions (org_id, type, state, source_currency, source_amount, dest_currency, provider_code, idem_key)
     values ($1,'payout','settled','BRLA',1000,'BRL','avenia',$2) returning id`,
    [orgId, randomUUID()],
  );
  const txId = tx.rows[0]!.id;

  const first = await createDisputeForOrg(orgId, null, { transactionId: txId, message: "Não reconheço este pagamento." });
  const second = await createDisputeForOrg(orgId, null, { transactionId: txId, message: "Complemento: valor errado." });
  assert.equal(first.caseId, second.caseId, "one open dispute per transaction");

  const kase = await pool.query("select type, priority, status from cases where id = $1", [first.caseId]);
  assert.equal(kase.rows[0].type, "customer_dispute");
  assert.equal(kase.rows[0].priority, "high");
  const msgs = await pool.query("select count(*)::int as n from case_messages where case_id = $1", [first.caseId]);
  assert.equal(msgs.rows[0]!.n, 2);
  const ack = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'dispute_received_ack'",
  );
  assert.equal(ack.rows[0]!.n, 1, "ack only on open, not on append");

  await assert.rejects(
    createDisputeForOrg(orgId, null, { transactionId: randomUUID(), message: "x" }),
    /transaction_not_found/,
  );

  // First-response SLA: null until an admin replies, then stamped.
  const before = (await listCases({ type: "customer_dispute" }))[0]!;
  assert.equal(before.first_admin_response_at, null);
  const admin = await createAdmin();
  await postAdminCaseMessage({ caseId: first.caseId, authorAdminId: admin, body: "Estamos verificando.", customerVisible: true });
  const afterReply = (await listCases({ type: "customer_dispute" }))[0]!;
  assert.ok(afterReply.first_admin_response_at, "first admin reply stops the SLA clock");
});

test("PRD-01 AC-1: non-ATIVA CNPJ rejected server-side; registry outage fails open with attestation", async () => {
  await assert.rejects(
    bootstrapOrgForClerkUser(
      `clerk_${randomUUID().slice(0, 8)}`,
      { cnpj: "11222333000181", razaoSocial: "Inativa SA", fullName: "F", email: "f@x.com" },
      async () => ({ ativa: false }),
    ),
    /cnpj_not_ativa/,
  );

  const uid = `clerk_${randomUUID().slice(0, 8)}`;
  const res = await bootstrapOrgForClerkUser(
    uid,
    { cnpj: "11222333000181", razaoSocial: "Aberta SA", fullName: "F", email: "f2@x.com" },
    async () => { throw new HttpError("cnpj_lookup_unavailable", 502); },
  );
  assert.ok(res.orgId);
  const att = await pool.query<{ payload: { checked: boolean } }>(
    "select payload from audit_log where org_id = $1 and event = 'signup.cnpj_situacao_checked'",
    [res.orgId],
  );
  assert.equal(att.rows[0]!.payload.checked, false, "outage attested as unchecked, signup not blocked");
});

test("PRD-01 §9: mock KYB persists ONE didit_verifications row per org, idempotently", async () => {
  const orgId = await createOrg("kyb_in_progress");
  const mock = new MockKybProvider();
  await mock.launchVerification({ orgId });
  await mock.launchVerification({ orgId }); // RFI re-launch path
  const rows = await pool.query(
    "select count(*)::int as n, min(status) as status from didit_verifications where org_id = $1", [orgId],
  );
  assert.equal(rows.rows[0]!.n, 1);
  assert.equal(rows.rows[0]!.status, "launched");
});

test("PRD-01 AC-15: an explicitly rejected USD rail blocks ACH payouts; default not_requested passes the gate", async () => {
  const orgId = await createOrg("active");
  await seedBalance(orgId, "USDT", 100_000_000n);
  const { id } = await createBeneficiaryForOrg(orgId, null, {
    label: "US Supplier", rail: "ach", payeeLegalName: "Acme Inc", purposeOfPayment: "invoice",
    destination: {
      routingNumber: "021000021", accountNumber: "12345678", bankName: "Chase",
      streetLine1: "1 Main St", city: "New York", state: "NY", postalCode: "10001",
    },
  });
  await pool.query("insert into avenia_accounts (org_id, subaccount_id, usd_state) values ($1, 'sub_x', 'rejected')", [orgId]);
  await assert.rejects(
    createPayout(orgId, null, { beneficiaryId: id, amount: "5", idemKey: randomUUID() }, {} as never),
    /rail_not_enabled/,
  );
});

test("PRD-07: setOrgAccess strict CAS — stale expected status is a 409, fresh one applies", async () => {
  const orgId = await createOrg("active");
  const admin = await createAdmin();
  await assert.rejects(
    setOrgAccess({ orgId, action: "suspend", reason: "r", changedByAdminId: admin, expectedStatus: "blocked" }),
    /access_status_conflict/,
  );
  await setOrgAccess({ orgId, action: "suspend", reason: "r", changedByAdminId: admin, expectedStatus: "active" });
  const row = await pool.query("select access_status from orgs where id = $1", [orgId]);
  assert.equal(row.rows[0].access_status, "suspended");
});

test("PRD-07: webhook volume alarm fires ONCE at the crossing, and never blocks intake", async () => {
  const threshold = 300; // env default
  await pool.query(
    `insert into rate_limits (key, route_class, window_start, count)
     values ('webhook_volume:avenia', 'webhook_volume', to_timestamp(floor(extract(epoch from now()) / 60) * 60), $1)`,
    [threshold],
  );
  const outcome = await receiveWebhook({
    provider: "avenia",
    externalId: randomUUID(),
    eventType: "x",
    rawBody: "{}",
    payload: {},
    headers: {},
    config: {},
    clientIp: null,
  });
  assert.notEqual(outcome.status, 429, "alarm never blocks");
  const alert = await pool.query(
    "select count(*)::int as n from notification_outbox where event_type = 'webhook_volume_alarm'",
  );
  assert.equal(alert.rows[0]!.n, 1);
});

test("F1 regression: a destination change during an in-flight payout never re-caches the OLD vendor record", async () => {
  const orgId = await createOrg("active");
  const { id } = await createBeneficiaryForOrg(orgId, null, pixBody());
  // createPayout captures the payee BEFORE the customer's destination change lands:
  const captured = await pool.query<{ id: string; rail: string; destination: Record<string, string> }>(
    "select id, rail, destination from avenia_beneficiaries where id = $1", [id],
  );
  // The customer replaces the destination (row -> changed_pending, vendor id cleared).
  await updateBeneficiaryForOrg(orgId, null, id, { destination: { pixKey: "00011122233", pixKeyType: "cpf" } });
  // Phase 2 of the in-flight payout forwards the CAPTURED (old) destination…
  const fake = {
    async createBrlBeneficiary() { return { id: "ben_OLD" }; },
    async createUsdBeneficiary() { return { id: "ben_OLD" }; },
    async createEurBeneficiary() { return { id: "ben_OLD" }; },
  };
  await ensureAveniaBeneficiary(
    orgId,
    { ...captured.rows[0]!, avenia_beneficiary_id: null, status: "active", label: "x", asset: "BRL", network: null, payee_legal_name: "x", payee_country: "BR" } as never,
    "sub_x",
    fake as never,
  );
  // …but the write-back must NOT stick to the changed_pending row.
  const row = await pool.query("select avenia_beneficiary_id from avenia_beneficiaries where id = $1", [id]);
  assert.equal(row.rows[0].avenia_beneficiary_id, null, "OLD vendor record never cached onto the changed row");
});
