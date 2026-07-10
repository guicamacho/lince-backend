import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { recordAveniaVerdict } from "../src/modules/onboarding/admission.service.js";
import { resetDb, createOrg, createAdmin } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("approved -> org active, admission_* set, audit logged AS A RELAY", async () => {
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending");
  await recordAveniaVerdict({ orgId: org, decision: "approved", aveniaReference: "AV-123", recordedByAdminId: admin });

  const { rows } = await pool.query(
    "select state, admission_state, admission_authority_used, admission_external_ref, admission_recorded_by from orgs where id = $1",
    [org],
  );
  assert.equal(rows[0].state, "active");
  assert.equal(rows[0].admission_state, "approved");
  assert.equal(rows[0].admission_authority_used, "avenia");
  assert.equal(rows[0].admission_external_ref, "AV-123");
  assert.equal(rows[0].admission_recorded_by, admin);

  const audit = await pool.query("select event, payload from audit_log where org_id = $1", [org]);
  assert.equal(audit.rows[0].event, "admission.avenia_verdict_relayed");
  assert.equal(audit.rows[0].payload.relay, true); // Modelo A: recorded as a relay, not a Lince decision
});

test("rejected -> org rejected + CNPJ denylisted", async () => {
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending", "11222333000199");
  await recordAveniaVerdict({ orgId: org, decision: "rejected", aveniaReference: "AV-999", recordedByAdminId: admin });

  const { rows } = await pool.query("select state from orgs where id = $1", [org]);
  assert.equal(rows[0].state, "rejected");
  const deny = await pool.query("select 1 from cnpj_denylist where cnpj = $1", ["11222333000199"]);
  assert.equal(deny.rowCount, 1);
});

test("a second relay on an already-decided org -> admission_already_recorded (CAS, pattern 8)", async () => {
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending");
  await recordAveniaVerdict({ orgId: org, decision: "approved", aveniaReference: "AV-1", recordedByAdminId: admin });
  await assert.rejects(
    recordAveniaVerdict({ orgId: org, decision: "rejected", aveniaReference: "AV-2", recordedByAdminId: admin }),
    /admission_already_recorded/,
  );
  // The org stays approved/active — the second relay never overwrote a decided verdict.
  const { rows } = await pool.query("select state, admission_state from orgs where id = $1", [org]);
  assert.equal(rows[0].admission_state, "approved");
  assert.equal(rows[0].state, "active");
});

test("TWO IN-FLIGHT conflicting relays -> exactly one wins, loser 409s (row lock proven)", async () => {
  // The sequential test above would pass even without FOR UPDATE; this one wouldn't:
  // both transactions read admission_state concurrently, so only the row lock forces
  // the second to see the first's committed verdict (verification-sweep finding).
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending");
  const results = await Promise.allSettled([
    recordAveniaVerdict({ orgId: org, decision: "approved", aveniaReference: "AV-RACE-A", recordedByAdminId: admin }),
    recordAveniaVerdict({ orgId: org, decision: "rejected", aveniaReference: "AV-RACE-B", recordedByAdminId: admin }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "exactly one relay recorded");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]!.reason), /admission_already_recorded/);

  // The org matches the WINNER (whichever it was) — never a blend, never a flip.
  const { rows } = await pool.query(
    "select state, admission_state, admission_external_ref from orgs where id = $1",
    [org],
  );
  const winnerWasApprove = rows[0].admission_external_ref === "AV-RACE-A";
  assert.equal(rows[0].admission_state, winnerWasApprove ? "approved" : "rejected");
  assert.equal(rows[0].state, winnerWasApprove ? "active" : "rejected");
  // Exactly one audit relay row.
  const audit = await pool.query(
    "select count(*)::int as n from audit_log where org_id = $1 and event = 'admission.avenia_verdict_relayed'",
    [org],
  );
  assert.equal(audit.rows[0].n, 1);
});

test("guard: rejects relay for a non-avenia jurisdiction", async () => {
  // Temp non-avenia jurisdiction (e.g. a hypothetical lince-admitted market).
  await pool.query(
    `insert into jurisdiction_policies (country_code, mode, admission_authority, kyb_provider)
     values ('XX','blocked','lince','didit') on conflict (country_code) do nothing`,
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into orgs (cnpj, razao_social, country_code, state) values ($1,'X Ltda','XX','vendor_pending') returning id`,
    [`${Date.now()}`],
  );
  const admin = await createAdmin();
  await assert.rejects(
    recordAveniaVerdict({ orgId: rows[0]!.id, decision: "approved", aveniaReference: "x", recordedByAdminId: admin }),
  );
});
