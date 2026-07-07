/** PRD-07 §2 pattern 4 (concurrency test 2): two admins decide the same approval in parallel;
 *  the CAS (WHERE decided_at is null) lets exactly one win, the other gets already_decided. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { enqueueApproval, decideApproval } from "../src/modules/admin/approvals.js";
import { resetDb, createAdmin, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("two concurrent decisions on one approval -> one ok, one already_decided, executed once", async () => {
  const requester = await createAdmin();
  const a = await createAdmin();
  const b = await createAdmin();
  const org = await createOrg();
  const { id } = await enqueueApproval({
    requestedByAdminId: requester,
    actionType: "org_block",
    targetRef: org,
    payload: { reason: "sanctions hit" },
  });

  // Two separate pool clients (decideApproval opens its own withTransaction) race on the row.
  const results = await Promise.allSettled([
    decideApproval({ id, decidedByAdminId: a, decision: "approved" }),
    decideApproval({ id, decidedByAdminId: b, decision: "approved" }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one decision committed");
  assert.equal(failed.length, 1, "the other got rows-affected 0");
  assert.match(String((failed[0] as PromiseRejectedResult).reason), /already_decided/);

  // The wired org_block executor ran exactly once (no double side effect).
  const audit = await pool.query(
    "select 1 from audit_log where org_id = $1 and event = 'org.access_changed'",
    [org],
  );
  assert.equal(audit.rowCount, 1);
  const blocked = await pool.query("select access_status from orgs where id = $1", [org]);
  assert.equal(blocked.rows[0].access_status, "blocked");
});
