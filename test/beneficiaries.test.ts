/** Beneficiaries — rail-aware capture (FIAT + CRYPTO) + travel-rule fields. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { listBeneficiariesForOrg, createBeneficiaryForOrg } from "../src/modules/beneficiaries/beneficiaries.service.js";
import { validateBeneficiary } from "../src/modules/beneficiaries/rails.js";
import { resetDb, createOrg } from "./helpers.js";
import { HttpError } from "../src/http/error.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// A valid ACH payee (simplest fiat rail) reused by the service tests.
const achBody = () => ({
  label: "US Supplier",
  rail: "ach",
  payeeLegalName: "Acme Inc",
  purposeOfPayment: "supplier invoice",
  destination: { routingNumber: "021000021", accountNumber: "12345678" },
});

const rejects = (body: Record<string, unknown>, code: RegExp | string) =>
  assert.throws(() => validateBeneficiary(body), (e) => e instanceof HttpError && new RegExp(code).test(e.message));

test("validateBeneficiary — PIX: derives BRL/BR, requires key + type", () => {
  const v = validateBeneficiary({
    label: "Fornecedor BR", rail: "pix", payeeLegalName: "Fornecedor Ltda", purposeOfPayment: "fatura",
    destination: { pixKey: "12.345.678/0001-99", pixKeyType: "cnpj" },
  });
  assert.equal(v.asset, "BRL");
  assert.equal(v.payeeCountry, "BR");
  assert.equal(v.rail, "pix");
  assert.deepEqual(v.destination, { pixKey: "12.345.678/0001-99", pixKeyType: "cnpj" });
  assert.equal(v.destHint, "1-99"); // last 4 chars of the key
  rejects({ label: "x", rail: "pix", payeeLegalName: "y", purposeOfPayment: "z", destination: { pixKey: "k", pixKeyType: "iban" } }, "invalid_pix_key_type");
  rejects({ label: "x", rail: "pix", payeeLegalName: "y", purposeOfPayment: "z", destination: { pixKeyType: "cpf" } }, "missing_pixKey");
});

test("validateBeneficiary — ACH/Fedwire: USD/US, 9-digit routing", () => {
  const v = validateBeneficiary(achBody());
  assert.equal(v.asset, "USD");
  assert.equal(v.payeeCountry, "US");
  assert.equal(v.destHint, "5678");
  rejects({ ...achBody(), destination: { routingNumber: "12", accountNumber: "1" } }, "invalid_routing_number");
});

test("validateBeneficiary — SEPA: EUR, IBAN+BIC shape, country from IBAN", () => {
  const v = validateBeneficiary({
    label: "EU Supplier", rail: "sepa", payeeLegalName: "EU GmbH", purposeOfPayment: "invoice",
    destination: { iban: "DE89 3704 0044 0532 0130 00", bic: "COBADEFFXXX" },
  });
  assert.equal(v.asset, "EUR");
  assert.equal(v.payeeCountry, "DE");
  assert.equal(v.destination.iban, "DE89370400440532013000"); // normalized
  rejects({ label: "x", rail: "sepa", payeeLegalName: "y", purposeOfPayment: "z", destination: { iban: "notaniban", bic: "COBADEFF" } }, "invalid_iban");
});

test("validateBeneficiary — SWIFT: asset in {USD,EUR,GBP}, BIC + account + bank country + payee country", () => {
  const base = {
    label: "Intl", rail: "swift", asset: "USD", payeeLegalName: "World Co", payeeCountry: "SG", purposeOfPayment: "invoice",
    destination: { swiftBic: "DBSSSGSG", accountNumber: "123456789", bankName: "DBS", bankCountry: "SG" },
  };
  const v = validateBeneficiary(base);
  assert.equal(v.asset, "USD");
  assert.equal(v.payeeCountry, "SG");
  rejects({ ...base, asset: "JPY" }, "invalid_swift_asset");
  rejects({ ...base, destination: { swiftBic: "DBSSSGSG", bankName: "DBS", bankCountry: "SG" } }, "missing_account");
});

test("validateBeneficiary — crypto: asset+network from catalog, per-family address shape", () => {
  const evm = validateBeneficiary({
    label: "Wallet", rail: "crypto", asset: "USDC", network: "Polygon", payeeCountry: "US", payeeLegalName: "Chain LLC",
    purposeOfPayment: "settlement", destination: { walletAddress: "0x" + "a".repeat(40) },
  });
  assert.equal(evm.asset, "USDC");
  assert.equal(evm.network, "Polygon");
  assert.equal(evm.rail, "crypto");
  rejects({ label: "x", rail: "crypto", asset: "USDT", network: "Base", payeeCountry: "US", payeeLegalName: "y", purposeOfPayment: "z", destination: { walletAddress: "0x1" } }, "invalid_network"); // USDT not on Base
  rejects({ label: "x", rail: "crypto", asset: "USDC", network: "Polygon", payeeCountry: "US", payeeLegalName: "y", purposeOfPayment: "z", destination: { walletAddress: "0xnothex" } }, "invalid_wallet_address");
  rejects({ label: "x", rail: "crypto", asset: "USDT", network: "TRON (TRC-20)", payeeCountry: "US", payeeLegalName: "y", purposeOfPayment: "z", destination: { walletAddress: "0x" + "a".repeat(40) } }, "invalid_wallet_address"); // EVM addr on TRON
});

test("validateBeneficiary — unknown rail + missing shared fields rejected", () => {
  rejects({ label: "x", rail: "wire", payeeLegalName: "y", purposeOfPayment: "z" }, "invalid_rail");
  rejects({ ...achBody(), label: "  " }, "missing_label");
  rejects({ ...achBody(), purposeOfPayment: "" }, "missing_purposeOfPayment");
});

test("createBeneficiaryForOrg persists the rail model; authorised_by resolves in-org; dest_hint = last4", async () => {
  const uid = clerkId();
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81", razaoSocial: "Acme Pagamentos Ltda", role: "CEO",
    fullName: "Maria Souza", email: `maria+${uid}@acme.test`,
  });
  const { id } = await createBeneficiaryForOrg(orgId, uid, achBody());
  const { rows } = await pool.query(
    "select rail, dest_currency, dest_hint, destination, authorised_by, avenia_beneficiary_id from avenia_beneficiaries where id=$1",
    [id],
  );
  assert.equal(rows[0].rail, "ach");
  assert.equal(rows[0].dest_currency, "USD");
  assert.equal(rows[0].dest_hint, "5678");
  assert.equal(rows[0].destination.routingNumber, "021000021");
  assert.equal(rows[0].avenia_beneficiary_id, null);
  const person = await pool.query("select id from people where clerk_user_id=$1", [uid]);
  assert.equal(rows[0].authorised_by, person.rows[0].id);
});

test("list is org-scoped, newest-first, and surfaces rail/asset/hint (no raw identifier)", async () => {
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");
  const first = await createBeneficiaryForOrg(orgA, null, { ...achBody(), label: "first" });
  const second = await createBeneficiaryForOrg(orgA, null, {
    label: "second", rail: "pix", payeeLegalName: "Br Ltda", purposeOfPayment: "fatura",
    destination: { pixKey: "chave@x.com", pixKeyType: "email" },
  });
  await createBeneficiaryForOrg(orgB, null, achBody());

  const rows = (await listBeneficiariesForOrg(orgA)) as Array<{ id: string; rail: string; asset: string }>;
  assert.deepEqual(rows.map((r) => r.id), [second.id, first.id]);
  assert.equal(rows[0].rail, "pix");
  assert.equal(rows[0].asset, "BRL");
  assert.ok(!("destination" in rows[0]), "list must not return the raw destination identifier");
});
