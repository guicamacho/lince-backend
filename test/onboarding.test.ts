/** v1 skeleton onboarding flow — bootstrap -> launch -> mock-verify -> admin relay. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { currentOrgForClerkUser, advanceCallerOrg } from "../src/modules/onboarding/onboardingState.js";
import { recordAveniaVerdict } from "../src/modules/onboarding/admission.service.js";
import { ensureAdminUser } from "../src/modules/identity/adminSync.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

test("DoD flow: bootstrap -> launch -> mock-verify -> admin approve -> active", async () => {
  const uid = clerkId();
  const { orgId, state } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  });
  assert.equal(state, "pending_lince_approval");
  assert.equal((await currentOrgForClerkUser(uid))?.state, "pending_lince_approval");

  assert.equal((await advanceCallerOrg(uid, "kyb_in_progress")).state, "kyb_in_progress");
  assert.equal((await advanceCallerOrg(uid, "vendor_pending")).state, "vendor_pending");

  // kyb_forwarded_at is stamped on the Avenia forward (aging clock).
  const fwd = await pool.query("select kyb_forwarded_at from orgs where id = $1", [orgId]);
  assert.ok(fwd.rows[0].kyb_forwarded_at, "kyb_forwarded_at set on -> vendor_pending");

  // The gate: admin records Avenia's verdict.
  const adminId = await ensureAdminUser(clerkId(), "ops@lince.test", "Ops");
  await recordAveniaVerdict({ orgId, decision: "approved", aveniaReference: "AV-skel-1", recordedByAdminId: adminId });

  const { rows } = await pool.query("select state, admission_state from orgs where id = $1", [orgId]);
  assert.equal(rows[0].state, "active");
  assert.equal(rows[0].admission_state, "approved");
});

test("transition guard: cannot skip kyb_in_progress (pending -> vendor_pending rejected)", async () => {
  const uid = clerkId();
  await bootstrapOrgForClerkUser(uid, {
    cnpj: "11222333000182",
    razaoSocial: "B Ltda",
    role: "CFO",
    fullName: "Joao",
    email: `joao+${uid}@b.test`,
  });
  await assert.rejects(advanceCallerOrg(uid, "vendor_pending"));
});

test("bootstrap is idempotent for the same Clerk user (one org per signup)", async () => {
  const uid = clerkId();
  const a = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11222333000182",
    razaoSocial: "C Ltda",
    role: "CEO",
    fullName: "Ana",
    email: `ana+${uid}@c.test`,
  });
  const b = await bootstrapOrgForClerkUser(uid, {
    cnpj: "99888777000166", // different CNPJ — ignored; same user already has an org
    razaoSocial: "C2 Ltda",
    role: "CEO",
    fullName: "Ana",
    email: `ana+${uid}@c.test`,
  });
  assert.equal(a.orgId, b.orgId);
});

test("bootstrap rejects incomplete input (missing cnpj)", async () => {
  await assert.rejects(
    bootstrapOrgForClerkUser(clerkId(), { razaoSocial: "X", fullName: "Y", email: "y@x.test" }),
  );
});
