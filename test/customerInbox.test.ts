/** Customer inbox — org-scoped reads + reply, and the L4 customer-visibility filter. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { postAdminCaseMessage } from "../src/modules/cases/messages.service.js";
import {
  listNotificationsForOrg,
  markNotificationRead,
  listCustomerCasesForOrg,
  getCaseThreadForOrg,
  postCustomerCaseReply,
} from "../src/modules/cases/customerInbox.service.js";
import { resetDb, createOrg, createAdmin, insertCase } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

async function notify(orgId: string, caseId: string | null = null) {
  await pool.query(
    "insert into customer_notifications (org_id, kind, case_id, title, body) values ($1, 'case_message', $2, 't', 'b')",
    [orgId, caseId],
  );
}

test("listNotificationsForOrg is org-scoped with an unread count", async () => {
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");
  await notify(orgA);
  await notify(orgA);
  await notify(orgB);

  const a = await listNotificationsForOrg(orgA);
  assert.equal(a.notifications.length, 2);
  assert.equal(a.unread, 2);

  await markNotificationRead(orgA, a.notifications[0]!.id);
  const a2 = await listNotificationsForOrg(orgA);
  assert.equal(a2.unread, 1); // one cleared, sibling still unread; orgB untouched
});

test("markNotificationRead is idempotent and cannot touch another org's row", async () => {
  const orgA = await createOrg("active");
  const orgB = await createOrg("active");
  await notify(orgA);
  const { id } = (await listNotificationsForOrg(orgA)).notifications[0]!;

  const first = await markNotificationRead(orgA, id);
  assert.deepEqual(first, { ok: true });
  // idempotent: second read does not throw and keeps it read
  await markNotificationRead(orgA, id);
  assert.equal((await listNotificationsForOrg(orgA)).unread, 0);

  // cross-org: orgB cannot mark orgA's row (looks like not-found)
  await assert.rejects(markNotificationRead(orgB, id), /notification_not_found/);
  // malformed id is a clean 404, not a pg 500
  await assert.rejects(markNotificationRead(orgA, "not-a-uuid"), /notification_not_found/);
});

test("listCustomerCasesForOrg returns only allowlisted-type, org-scoped cases", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const otherOrg = await createOrg("active");
  const rfi = await insertCase("rfi_relay", orgId, admin);
  await insertCase("kyb_completeness", orgId, admin);
  await insertCase("manual_review", orgId, admin);          // not allowlisted -> hidden
  await insertCase("avenia_decision_relay", orgId, admin);  // not allowlisted -> hidden
  await insertCase("rfi_relay", otherOrg, admin);           // other org -> hidden

  const cases = await listCustomerCasesForOrg(orgId);
  assert.equal(cases.length, 2);
  assert.ok(cases.every((c: { type: string }) => c.type === "rfi_relay" || c.type === "kyb_completeness"));
  assert.ok(cases.some((c: { id: string }) => c.id === rfi));
});

test("getCaseThreadForOrg returns ONLY customer_visible messages; 404 cross-org and non-allowlisted", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const otherOrg = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);
  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "customer can see this", customerVisible: true });
  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "internal note", customerVisible: false });

  const thread = await getCaseThreadForOrg(orgId, caseId);
  assert.equal(thread.messages.length, 1); // internal note filtered out
  assert.equal(thread.messages[0]!.body, "customer can see this");
  assert.equal("author_id" in thread.messages[0]!, false); // staff id never serialized to customer

  await assert.rejects(getCaseThreadForOrg(otherOrg, caseId), /case_not_found/); // cross-org
  const manual = await insertCase("manual_review", orgId, admin);
  await assert.rejects(getCaseThreadForOrg(orgId, manual), /case_not_found/);    // non-allowlisted
});

test("customer never sees internal statuses (in_review/escalated coarsen to open)", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);
  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "veja", customerVisible: true });

  for (const internal of ["in_review", "escalated"]) {
    await pool.query("update cases set status = $2 where id = $1", [caseId, internal]);
    const [listed] = await listCustomerCasesForOrg(orgId);
    assert.equal(listed!.status, "open", `list coarsens ${internal} -> open`);
    const thread = await getCaseThreadForOrg(orgId, caseId);
    assert.equal(thread.case.status, "open", `thread coarsens ${internal} -> open`);
  }
  await pool.query("update cases set status = 'closed' where id = $1", [caseId]);
  assert.equal((await getCaseThreadForOrg(orgId, caseId)).case.status, "closed");
});

test("postCustomerCaseReply inserts a customer message; rejects closed / non-allowlisted / cross-org", async () => {
  const admin = await createAdmin();
  const uid = `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const { orgId } = await bootstrapOrgForClerkUser(uid, {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  });
  const caseId = await insertCase("rfi_relay", orgId, admin);

  const { id } = await postCustomerCaseReply(orgId, uid, caseId, "Segue o documento solicitado.");
  const row = await pool.query<{ author_type: string; author_id: string | null; customer_visible: boolean }>(
    "select author_type, author_id, customer_visible from case_messages where id = $1", [id]);
  assert.equal(row.rows[0]!.author_type, "customer");
  assert.equal(row.rows[0]!.customer_visible, true);
  const person = await pool.query("select id from people where clerk_user_id = $1", [uid]);
  assert.equal(row.rows[0]!.author_id, person.rows[0]!.id); // attributed via org membership

  // non-allowlisted (same org) -> distinct 400
  const manual = await insertCase("manual_review", orgId, admin);
  await assert.rejects(postCustomerCaseReply(orgId, uid, manual, "hi"), /case_not_open_to_reply/);

  // cross-org -> 404
  const other = await createOrg("active");
  const otherCase = await insertCase("rfi_relay", other, admin);
  await assert.rejects(postCustomerCaseReply(orgId, uid, otherCase, "hi"), /case_not_found/);

  // closed -> 409
  await pool.query("update cases set status = 'closed' where id = $1", [caseId]);
  await assert.rejects(postCustomerCaseReply(orgId, uid, caseId, "hi"), /case_closed/);
});

test("reply body is length-capped and has HTML/URLs stripped", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);

  const dirty = `<script>alert(1)</script>veja http://evil.example/x e www.bad.test agora`;
  const { id } = await postCustomerCaseReply(orgId, null, caseId, dirty);
  const { rows } = await pool.query<{ body: string }>("select body from case_messages where id = $1", [id]);
  const body = rows[0]!.body;
  assert.ok(!body.includes("<"), "HTML tags stripped");
  assert.ok(!body.includes("http://"), "http URL neutralised");
  assert.ok(!/www\.bad/.test(body), "www URL neutralised");
  assert.ok(body.includes("[link removido]"), "URL replaced with neutral marker");

  // length cap
  const long = "a".repeat(9000);
  const r2 = await postCustomerCaseReply(orgId, null, caseId, long);
  const { rows: r2rows } = await pool.query<{ body: string }>("select body from case_messages where id = $1", [r2.id]);
  assert.ok(r2rows[0]!.body.length <= 4000, "body capped at 4000");

  // fully-stripped body -> empty -> rejected
  await assert.rejects(postCustomerCaseReply(orgId, null, caseId, "<br><br>"), /empty_body/);
});
