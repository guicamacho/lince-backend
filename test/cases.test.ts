/** Cases service — staff-side CRUD over the operational taxonomy (Modelo A). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import {
  createCase,
  listCases,
  getCaseDetail,
  assignCase,
  updateCaseStatus,
  OPERATIONAL_CASE_TYPES,
} from "../src/modules/cases/cases.service.js";
import { postAdminCaseMessage } from "../src/modules/cases/messages.service.js";
import { resetDb, createOrg, createAdmin, insertCase } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("createCase rejects AML/unknown types and accepts every operational type", async () => {
  const admin = await createAdmin();
  for (const t of ["aml_alert", "sanctions_hit", "pep_match", "sar", "not_a_type"]) {
    await assert.rejects(createCase({ type: t, openedByAdminId: admin }), /invalid_case_type/);
  }
  for (const t of OPERATIONAL_CASE_TYPES) {
    const c = await createCase({ type: t, openedByAdminId: admin });
    assert.ok(c.id, `created ${t}`);
    assert.equal(c.status, "open");
    assert.equal(c.type, t);
  }
});

test("createCase rejects a bogus priority", async () => {
  const admin = await createAdmin();
  await assert.rejects(createCase({ type: "support", priority: "sky_high", openedByAdminId: admin }), /invalid_priority/);
});

test("listCases filters by type, status and org", async () => {
  const admin = await createAdmin();
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");
  await createCase({ type: "rfi_relay", orgId: orgA, openedByAdminId: admin });
  await createCase({ type: "support", orgId: orgA, openedByAdminId: admin });
  await createCase({ type: "rfi_relay", orgId: orgB, openedByAdminId: admin });

  assert.equal((await listCases({ type: "rfi_relay" })).length, 2);
  assert.equal((await listCases({ orgId: orgA })).length, 2);
  assert.equal((await listCases({ type: "rfi_relay", orgId: orgB })).length, 1);
  assert.equal((await listCases({ status: "open" })).length, 3);
  assert.equal((await listCases({ status: "closed" })).length, 0);
});

test("assignCase sets the assignee; rejects an unknown admin and unknown case", async () => {
  const admin = await createAdmin();
  const assignee = await createAdmin();
  const caseId = await insertCase("support", null, admin);

  const r = await assignCase(caseId, assignee);
  assert.equal(r.assigned_admin_id, assignee);

  await assert.rejects(assignCase(caseId, "00000000-0000-0000-0000-000000000000"), /invalid_admin/);
  await assert.rejects(assignCase("11111111-1111-1111-1111-111111111111", assignee), /case_not_found/);
});

test("updateCaseStatus transitions, requires resolution on close, sets closed_at", async () => {
  const admin = await createAdmin();
  const caseId = await insertCase("support", null, admin);

  const reviewed = await updateCaseStatus({ caseId, status: "in_review" });
  assert.equal(reviewed.status, "in_review");
  assert.equal(reviewed.closed_at, null);

  await assert.rejects(updateCaseStatus({ caseId, status: "closed" }), /resolution_required_on_close/);
  await assert.rejects(updateCaseStatus({ caseId, status: "banana" }), /invalid_status/);

  const closed = await updateCaseStatus({ caseId, status: "closed", resolution: "resolved with the customer" });
  assert.equal(closed.status, "closed");
  assert.ok(closed.closed_at, "closed_at set");
});

test("getCaseDetail returns the case, org and full thread (incl. internal notes)", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);
  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "visible to customer", customerVisible: true });
  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "internal only", customerVisible: false });

  const detail = await getCaseDetail(caseId);
  assert.equal(detail.case.id, caseId);
  assert.equal(detail.org.id, orgId);
  assert.equal(detail.messages.length, 2); // staff see both
  await assert.rejects(getCaseDetail("22222222-2222-2222-2222-222222222222"), /case_not_found/);
});
