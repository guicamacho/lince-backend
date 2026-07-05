/**
 * Case messages + the tipping-off wall. The HEADLINE guardrail lives here: a manual_review
 * and an avenia_decision_relay case can produce NEITHER a customer-visible message NOR a
 * customer_notifications row.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import {
  postAdminCaseMessage,
  messageCanBeCustomerVisible,
  NEUTRAL_NOTIFICATION_COPY,
} from "../src/modules/cases/messages.service.js";
import { resetDb, createOrg, createAdmin, insertCase } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// --- L2 pure gate — no DB ---
test("messageCanBeCustomerVisible is the pure allowlist gate", () => {
  assert.equal(messageCanBeCustomerVisible("rfi_relay", true), true);
  assert.equal(messageCanBeCustomerVisible("kyb_completeness", true), true);
  // defaults closed — must be explicitly requested
  assert.equal(messageCanBeCustomerVisible("rfi_relay", false), false);
  // reserved (A2) + never-facing types can never be customer-visible
  for (const t of ["customer_inquiry", "customer_dispute", "avenia_decision_relay",
                   "manual_review", "support", "beneficiary_review", "recon_break", "dormant_review"]) {
    assert.equal(messageCanBeCustomerVisible(t, true), false, t);
  }
});

test("empty body is rejected", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);
  await assert.rejects(postAdminCaseMessage({ caseId, authorAdminId: admin, body: "   " }), /empty_body/);
});

test("internal note (customer_visible=false) writes the message but NO notification", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);

  await postAdminCaseMessage({ caseId, authorAdminId: admin, body: "note to self", customerVisible: false });

  const msg = await pool.query("select customer_visible from case_messages where case_id = $1", [caseId]);
  assert.equal(msg.rowCount, 1);
  assert.equal(msg.rows[0]!.customer_visible, false);
  const notif = await pool.query("select 1 from customer_notifications where case_id = $1", [caseId]);
  assert.equal(notif.rowCount, 0);
});

test("customer-visible rfi_relay message inserts message + NEUTRAL notification atomically", async () => {
  const admin = await createAdmin();
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, admin);
  const staffText = "Please upload your latest supplier invoice for order 4471.";

  const { id } = await postAdminCaseMessage({ caseId, authorAdminId: admin, body: staffText, customerVisible: true });

  const msg = await pool.query<{ customer_visible: boolean; body: string }>(
    "select customer_visible, body from case_messages where id = $1", [id]);
  assert.equal(msg.rows[0]!.customer_visible, true);
  assert.equal(msg.rows[0]!.body, staffText);

  const notif = await pool.query<{ org_id: string; kind: string; title: string; body: string }>(
    "select org_id, kind, title, body from customer_notifications where case_id = $1", [caseId]);
  assert.equal(notif.rowCount, 1);
  assert.equal(notif.rows[0]!.org_id, orgId);
  assert.equal(notif.rows[0]!.kind, "case_message");
  // L3 — neutral copy, NEVER the raw staff text (tipping-off-safe).
  assert.equal(notif.rows[0]!.title, NEUTRAL_NOTIFICATION_COPY["rfi_relay"]!.title);
  assert.equal(notif.rows[0]!.body, NEUTRAL_NOTIFICATION_COPY["rfi_relay"]!.body);
  assert.notEqual(notif.rows[0]!.body, staffText);
});

// --- THE HEADLINE GUARDRAIL ---
test("guardrail: manual_review and avenia_decision_relay produce NEITHER a visible message NOR a notification", async () => {
  const admin = await createAdmin();
  for (const type of ["manual_review", "avenia_decision_relay"]) {
    const orgId = await createOrg("active");
    const caseId = await insertCase(type, orgId, admin);

    await assert.rejects(
      postAdminCaseMessage({ caseId, authorAdminId: admin, body: "should never reach the customer", customerVisible: true }),
      /message_not_customer_visible_for_type/,
      type,
    );

    // The refused post is rolled back: zero of BOTH.
    const visibleMsgs = await pool.query(
      "select 1 from case_messages where case_id = $1 and customer_visible = true", [caseId]);
    const notifs = await pool.query("select 1 from customer_notifications where case_id = $1", [caseId]);
    assert.equal(visibleMsgs.rowCount, 0, `${type}: no customer-visible message`);
    assert.equal(notifs.rowCount, 0, `${type}: no notification`);
  }
});
