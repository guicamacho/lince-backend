/** Org 360 read (A2): org + admission (with elapsed) + team + audit; not-found; no PII leak. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { advanceCallerOrg } from "../src/modules/onboarding/onboardingState.js";
import { getOrgDetail } from "../src/modules/admin/orgDetail.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

test("returns org + admission (with elapsed) + people + audit rows", async () => {
  const uid = clerkId();
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  });
  // -> vendor_pending stamps kyb_forwarded_at, so admission is pending with a live elapsed.
  await advanceCallerOrg(uid, "kyb_in_progress");
  await advanceCallerOrg(uid, "vendor_pending");

  const detail = await getOrgDetail(orgId);
  assert.equal(detail.org.id, orgId);
  assert.equal(detail.org.razao_social, "Acme Pagamentos Ltda");
  assert.equal(detail.org.state, "vendor_pending");

  assert.ok(detail.admission.submitted_at, "submitted_at set once forwarded");
  assert.equal(detail.admission.recorded_at, null); // still pending
  assert.ok(typeof detail.admission.elapsed_seconds === "number" && detail.admission.elapsed_seconds >= 0);

  assert.equal(detail.people.length, 1);
  assert.equal(detail.people[0]!.full_name, "Maria Souza");
  assert.deepEqual([...detail.people[0]!.roles].sort(), ["legal_rep", "owner"]);

  // bootstrap wrote a consent.accepted audit row -> the history is non-empty.
  assert.ok(detail.audit.some((a) => a.event === "consent.accepted"));
});

test("unknown id -> org_not_found", async () => {
  await assert.rejects(getOrgDetail("00000000-0000-0000-0000-000000000000"), /org_not_found/);
});

test("people carry operational identity only (no PII columns)", async () => {
  const uid = clerkId();
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "99.888.777/0001-66",
    razaoSocial: "NoPii Ltda",
    role: "CEO",
    fullName: "Rep",
    email: `rep+${uid}@nopii.test`,
  });
  const detail = await getOrgDetail(orgId);
  assert.deepEqual(Object.keys(detail.people[0]!).sort(), ["email", "full_name", "roles", "status"]);
  // Nothing CPF-shaped anywhere in the payload (Modelo A: no KYC PII retained).
  assert.ok(!JSON.stringify(detail).toLowerCase().includes("cpf"));
});
