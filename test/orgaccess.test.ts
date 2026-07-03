/** setOrgAccess — the 0002 access_status write path (suspend / block / reinstate). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { currentOrgForClerkUser, advanceCallerOrg } from "../src/modules/onboarding/onboardingState.js";
import { recordAveniaVerdict } from "../src/modules/onboarding/admission.service.js";
import { ensureAdminUser } from "../src/modules/identity/adminSync.js";
import { activeOrgForClerkUser } from "../src/modules/access/orgContext.js";
import { setOrgAccess } from "../src/modules/access/access.service.js";
import { resetDb, createAdmin } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

/** Build an ACTIVE org for a Clerk user via the DoD flow (bootstrap -> ... -> approve). */
async function createActiveOrgFor(uid: string): Promise<string> {
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  });
  await advanceCallerOrg(uid, "kyb_in_progress");
  await advanceCallerOrg(uid, "vendor_pending");
  const adminId = await ensureAdminUser(clerkId(), "ops@lince.test", "Ops");
  await recordAveniaVerdict({ orgId, decision: "approved", aveniaReference: "AV-acc-1", recordedByAdminId: adminId });
  return orgId;
}

test("suspend writes all access_* columns, audits from/to, and closes the /app gate", async () => {
  const uid = clerkId();
  const orgId = await createActiveOrgFor(uid);
  const admin = await createAdmin();
  assert.equal(await activeOrgForClerkUser(uid), orgId);

  await setOrgAccess({ orgId, action: "suspend", reason: "routine review", changedByAdminId: admin });

  const { rows } = await pool.query(
    `select access_status, access_reason, access_source, access_changed_by, access_changed_at
       from orgs where id = $1`,
    [orgId],
  );
  assert.equal(rows[0].access_status, "suspended");
  assert.equal(rows[0].access_reason, "routine review");
  assert.equal(rows[0].access_source, "lince_operational"); // default when not provided
  assert.equal(rows[0].access_changed_by, admin);
  assert.ok(rows[0].access_changed_at, "access_changed_at stamped");

  const audit = await pool.query(
    "select payload from audit_log where org_id = $1 and event = 'org.access_changed'",
    [orgId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].payload.action, "suspend");
  assert.equal(audit.rows[0].payload.from, "active");
  assert.equal(audit.rows[0].payload.to, "suspended");
  assert.equal(audit.rows[0].payload.reason, "routine review");

  // The gate flips (the app.ts /app 403 condition) while lifecycle state stays 'active'.
  assert.equal(await activeOrgForClerkUser(uid), null);
  const snap = await currentOrgForClerkUser(uid);
  assert.equal(snap?.state, "active");
  assert.equal(snap?.accessStatus, "suspended");
});

test("reinstate reopens the gate and audits a second row", async () => {
  const uid = clerkId();
  const orgId = await createActiveOrgFor(uid);
  const admin = await createAdmin();
  await setOrgAccess({ orgId, action: "suspend", reason: "routine review", changedByAdminId: admin });
  await setOrgAccess({ orgId, action: "reinstate", reason: "review cleared", changedByAdminId: admin });

  assert.equal(await activeOrgForClerkUser(uid), orgId);
  assert.equal((await currentOrgForClerkUser(uid))?.accessStatus, "active");

  const audit = await pool.query(
    `select payload from audit_log
      where org_id = $1 and event = 'org.access_changed' order by created_at asc`,
    [orgId],
  );
  assert.equal(audit.rowCount, 2);
  assert.equal(audit.rows[1].payload.from, "suspended");
  assert.equal(audit.rows[1].payload.to, "active");
});

test("block sets access_status = blocked", async () => {
  const uid = clerkId();
  const orgId = await createActiveOrgFor(uid);
  const admin = await createAdmin();
  await setOrgAccess({ orgId, action: "block", reason: "exit decision", changedByAdminId: admin });

  const { rows } = await pool.query("select access_status from orgs where id = $1", [orgId]);
  assert.equal(rows[0].access_status, "blocked");
  assert.equal(await activeOrgForClerkUser(uid), null);
});

test("empty reason is rejected for every action", async () => {
  const orgId = await createActiveOrgFor(clerkId());
  const admin = await createAdmin();
  for (const action of ["suspend", "block", "reinstate"] as const) {
    await assert.rejects(setOrgAccess({ orgId, action, reason: "   ", changedByAdminId: admin }), /reason_required/);
  }
});

test("unknown org -> org_not_found", async () => {
  const admin = await createAdmin();
  await assert.rejects(
    setOrgAccess({
      orgId: "00000000-0000-0000-0000-000000000000",
      action: "suspend",
      reason: "x",
      changedByAdminId: admin,
    }),
    /org_not_found/,
  );
});
