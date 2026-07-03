/** Beneficiaries service — travel-rule capture (backfill for the extracted routes). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import {
  listBeneficiariesForOrg,
  createBeneficiaryForOrg,
} from "../src/modules/beneficiaries/beneficiaries.service.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const validBody = () => ({
  label: "Supplier AU",
  payeeLegalName: "Down Under Pty Ltd",
  payeeCountry: "AU",
  payeeBankPsp: "CBA",
  payeeAccount: "062000-12345678",
  purposeOfPayment: "supplier invoice",
});

test("each missing required field rejects with missing_<field>", async () => {
  const orgId = await createOrg("active");
  const required = ["label", "payeeLegalName", "payeeCountry", "payeeBankPsp", "payeeAccount", "purposeOfPayment"];
  for (const k of required) {
    const body: Record<string, unknown> = { ...validBody(), [k]: "   " };
    await assert.rejects(createBeneficiaryForOrg(orgId, null, body), new RegExp(`missing_${k}`));
  }
});

test("authorised_by resolves for an in-org Clerk user; dest_hint = account last 4", async () => {
  const uid = clerkId();
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  });
  const { id } = await createBeneficiaryForOrg(orgId, uid, validBody());

  const { rows } = await pool.query(
    "select org_id, dest_hint, authorised_by, avenia_beneficiary_id from avenia_beneficiaries where id = $1",
    [id],
  );
  assert.equal(rows[0].org_id, orgId);
  assert.equal(rows[0].dest_hint, "5678");
  assert.equal(rows[0].avenia_beneficiary_id, null); // forwarding is mocked in P1
  const person = await pool.query("select id from people where clerk_user_id = $1", [uid]);
  assert.equal(rows[0].authorised_by, person.rows[0].id);
});

test("authorised_by is null for a Clerk user outside the org", async () => {
  // A REAL user linked to a different org — proves the op.org_id scope, not just "no people row".
  const outsider = clerkId();
  await bootstrapOrgForClerkUser(outsider, {
    cnpj: "11.444.777/0001-61",
    razaoSocial: "Outra Empresa Ltda",
    role: "CFO",
    fullName: "João Lima",
    email: `joao+${outsider}@outra.test`,
  });
  const orgId = await createOrg("active");
  const { id } = await createBeneficiaryForOrg(orgId, outsider, validBody());
  const { rows } = await pool.query("select authorised_by from avenia_beneficiaries where id = $1", [id]);
  assert.equal(rows[0].authorised_by, null);
});

test("list is org-scoped and newest-first", async () => {
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");
  const first = await createBeneficiaryForOrg(orgA, null, { ...validBody(), label: "first" });
  const second = await createBeneficiaryForOrg(orgA, null, { ...validBody(), label: "second" });
  await createBeneficiaryForOrg(orgB, null, validBody());

  const rows = await listBeneficiariesForOrg(orgA);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r: { id: string }) => r.id), [second.id, first.id]);
});
