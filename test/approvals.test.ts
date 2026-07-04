/** Maker-checker queue (A4): enqueue / list / decide with CAS + DB-enforced maker-checker
 *  + the wired org_block executor. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { enqueueApproval, listOpenApprovals, decideApproval } from "../src/modules/admin/approvals.js";
import { resetDb, createAdmin, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("enqueue creates an open row", async () => {
  const admin = await createAdmin();
  const org = await createOrg();
  const row = await enqueueApproval({
    requestedByAdminId: admin,
    actionType: "org_block",
    targetRef: org,
    payload: { reason: "exit decision" },
  });
  assert.ok(row.id);
  assert.equal(row.action_type, "org_block");
  assert.equal(row.target_ref, org);
  const { rows } = await pool.query("select decided_at, requested_by from pending_approvals where id = $1", [row.id]);
  assert.equal(rows[0].decided_at, null);
  assert.equal(rows[0].requested_by, admin);
});

test("list returns open rows only, oldest first", async () => {
  const a = await createAdmin();
  const b = await createAdmin();
  const org1 = await createOrg();
  const org2 = await createOrg();
  const first = await enqueueApproval({ requestedByAdminId: a, actionType: "org_block", targetRef: org1, payload: { reason: "x" } });
  const second = await enqueueApproval({ requestedByAdminId: a, actionType: "org_block", targetRef: org2, payload: { reason: "y" } });
  // Decide the second -> it drops out of the open list.
  await decideApproval({ id: second.id, decidedByAdminId: b, decision: "declined", remark: "not now" });

  const open = await listOpenApprovals();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.id, first.id);
  assert.equal(open[0]!.requested_by_name, "Ops Admin");
});

test("a different admin approves org_block -> org blocked + audited, executed=true", async () => {
  const requester = await createAdmin();
  const approver = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({
    requestedByAdminId: requester,
    actionType: "org_block",
    targetRef: org,
    payload: { reason: "sanctions hit" },
  });

  const result = await decideApproval({ id, decidedByAdminId: approver, decision: "approved" });
  assert.equal(result.decision, "approved");
  assert.equal(result.executed, true);

  const { rows } = await pool.query("select access_status, access_reason, access_changed_by from orgs where id = $1", [org]);
  assert.equal(rows[0].access_status, "blocked");
  assert.equal(rows[0].access_reason, "sanctions hit");
  assert.equal(rows[0].access_changed_by, approver); // the DECIDER is the acting admin

  const audit = await pool.query(
    "select payload from audit_log where org_id = $1 and event = 'org.access_changed'",
    [org],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].payload.to, "blocked");
});

test("the requester cannot decide their own request -> maker_checker_violation (DB CHECK)", async () => {
  const requester = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({ requestedByAdminId: requester, actionType: "org_block", targetRef: org, payload: { reason: "x" } });
  await assert.rejects(
    decideApproval({ id, decidedByAdminId: requester, decision: "approved" }),
    /maker_checker_violation/,
  );
  // Nothing executed: the row is still open, the org still active.
  const { rows } = await pool.query("select decided_at from pending_approvals where id = $1", [id]);
  assert.equal(rows[0].decided_at, null);
  const org2 = await pool.query("select access_status from orgs where id = $1", [org]);
  assert.equal(org2.rows[0].access_status, "active");
});

test("deciding an already-decided row -> already_decided (CAS returns 0)", async () => {
  const requester = await createAdmin();
  const approver = await createAdmin();
  const third = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({ requestedByAdminId: requester, actionType: "org_block", targetRef: org, payload: { reason: "x" } });
  await decideApproval({ id, decidedByAdminId: approver, decision: "declined", remark: "no" });
  await assert.rejects(
    decideApproval({ id, decidedByAdminId: third, decision: "approved" }),
    /already_decided/,
  );
});

test("decline records the decision but executes nothing", async () => {
  const requester = await createAdmin();
  const approver = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({ requestedByAdminId: requester, actionType: "org_block", targetRef: org, payload: { reason: "x" } });
  const result = await decideApproval({ id, decidedByAdminId: approver, decision: "declined", remark: "insufficient evidence" });
  assert.equal(result.decision, "declined");
  assert.equal(result.executed, false);

  const { rows } = await pool.query("select access_status from orgs where id = $1", [org]);
  assert.equal(rows[0].access_status, "active"); // untouched
  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'org.access_changed'", [org]);
  assert.equal(audit.rowCount, 0);
});

test("a decline with no remark is rejected", async () => {
  const requester = await createAdmin();
  const approver = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({ requestedByAdminId: requester, actionType: "org_block", targetRef: org, payload: { reason: "x" } });
  await assert.rejects(
    decideApproval({ id, decidedByAdminId: approver, decision: "declined" }),
    /remark_required_on_decline/,
  );
});
