/** RFI relay: state transition + customer-visible thread reachable pre-active + reply loop. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { raiseRfi } from "../src/modules/onboarding/rfi.service.js";
import { getOpenRfiThreadForOrg, listNotificationsForOrg, postCustomerCaseReply } from "../src/modules/cases/customerInbox.service.js";
import { resetDb, createOrg, createAdmin } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("raiseRfi: org -> rfi_required, customer-visible thread + neutral ping, audited as relay", async () => {
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending");
  const { caseId } = await raiseRfi({ orgId: org, adminId: admin, message: "Envie o comprovante de faturamento dos últimos 12 meses." });

  const state = await pool.query("select state from orgs where id = $1", [org]);
  assert.equal(state.rows[0].state, "rfi_required");

  // The customer can read the RFI thread WHILE NOT ACTIVE (the whole point).
  const thread = await getOpenRfiThreadForOrg(org);
  assert.equal((thread.case as { id: string }).id, caseId);
  assert.equal(thread.messages.length, 1);
  assert.match((thread.messages[0] as { body: string }).body, /comprovante de faturamento/);

  // The inbox ping is NEUTRAL (never the raw staff text — tipping-off wall).
  const inbox = await listNotificationsForOrg(org);
  assert.equal(inbox.unread, 1);
  assert.doesNotMatch(inbox.notifications[0].body, /faturamento/);

  const audit = await pool.query("select 1 from audit_log where org_id = $1 and event = 'admission.rfi_relayed'", [org]);
  assert.equal(audit.rowCount, 1);

  // Email ping enqueued in the same tx (neutral template; detail stays behind login).
  const outbox = await pool.query(
    "select 1 from notification_outbox where event_type = 'rfi_requested' and recipient_ref = $1",
    [org],
  );
  assert.equal(outbox.rowCount, 1);
});

test("raiseRfi reuses the open rfi_relay case across rounds (no case-per-message)", async () => {
  const admin = await createAdmin();
  const org = await createOrg("kyb_in_progress");
  const first = await raiseRfi({ orgId: org, adminId: admin, message: "Primeiro pedido." });
  // org is now rfi_required; a second EDD round from that state must be allowed and reuse the case.
  const second = await raiseRfi({ orgId: org, adminId: admin, message: "Segundo pedido." });
  assert.equal(first.caseId, second.caseId);
  const cases = await pool.query("select count(*)::int as n from cases where org_id = $1 and type = 'rfi_relay'", [org]);
  assert.equal(cases.rows[0].n, 1);
  const thread = await getOpenRfiThreadForOrg(org);
  assert.equal(thread.messages.length, 2);
});

test("customer replies to the RFI thread pre-active (closes the loop)", async () => {
  const admin = await createAdmin();
  const org = await createOrg("vendor_pending");
  await raiseRfi({ orgId: org, adminId: admin, message: "Precisamos de mais detalhes." });
  const thread = await getOpenRfiThreadForOrg(org);
  await postCustomerCaseReply(org, null, (thread.case as { id: string }).id, "Segue o documento solicitado.");
  const after = await getOpenRfiThreadForOrg(org);
  assert.equal(after.messages.length, 2);
  assert.equal((after.messages[1] as { author_type: string }).author_type, "customer");
});

test("raiseRfi refuses illegal source states (only vendor_pending / kyb_in_progress / rfi_required)", async () => {
  const admin = await createAdmin();
  const active = await createOrg("active");
  await assert.rejects(() => raiseRfi({ orgId: active, adminId: admin, message: "x" }), /org_state_not_eligible_for_rfi/);
  const pending = await createOrg("pending_lince_approval", "11222333000199");
  await assert.rejects(() => raiseRfi({ orgId: pending, adminId: admin, message: "x" }), /org_state_not_eligible_for_rfi/);
});

test("no open RFI -> empty thread (not an error)", async () => {
  const org = await createOrg("vendor_pending");
  const thread = await getOpenRfiThreadForOrg(org);
  assert.equal(thread.case, null);
  assert.equal(thread.messages.length, 0);
});
