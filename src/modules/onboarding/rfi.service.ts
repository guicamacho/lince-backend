/**
 * RFI relay — an ops admin relays Avenia's Enhanced Due Diligence (EDD) info request to a
 * customer (e.g. more documents to raise deposit/send limits). Avenia asks Lince by email;
 * Lince surfaces it to the customer through the onboarding-visible case thread.
 *
 * MODELO A: this is a RELAY, not a Lince request. Atomic (one txn):
 *   1. org state -> rfi_required (only from vendor_pending / kyb_in_progress — assertTransition)
 *   2. reuse the org's open rfi_relay case, or open one
 *   3. post the customer-visible message (tipping-off wall + neutral notification via the
 *      shared poster) — the customer sees the detail in the thread, a neutral ping elsewhere
 *   4. audit as a relay
 *
 * Closing the loop: the customer replies in the thread (postCustomerCaseReply) and/or, for a
 * KYB-completeness RFI, re-launches verification (rfi_required -> kyb_in_progress). When Avenia
 * answers, the ops admin records the verdict (recordAveniaVerdict), leaving rfi_required.
 */
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { canTransition, type OrgState } from "../identity/org.state.js";
import { postAdminCaseMessageOn } from "../cases/messages.service.js";

export interface RaiseRfiInput {
  orgId: string;
  adminId: string; // admin_users.id (resolved via ensureAdminUser)
  message: string; // the EDD request, shown verbatim to the customer in the thread
}

export async function raiseRfi(input: RaiseRfiInput): Promise<{ caseId: string; state: OrgState }> {
  const message = String(input.message ?? "").trim();
  if (!message) throw new HttpError("message_required", 400);
  if (message.length > 5000) throw new HttpError("message_too_long", 422);

  return withTransaction(async (c) => {
    const { rows } = await c.query<{ state: OrgState }>(
      `select state from orgs where id = $1 and deleted_at is null for update`,
      [input.orgId],
    );
    const org = rows[0];
    if (!org) throw new HttpError("org_not_found", 404);
    // Already in RFI = a follow-up EDD round: append to the thread, no state change. Otherwise
    // transition in — only vendor_pending / kyb_in_progress are eligible; anything else is a
    // clean 409 (not a raw 500 from the bare assertTransition Error).
    if (org.state !== "rfi_required") {
      if (!canTransition(org.state, "rfi_required")) {
        throw new HttpError("org_state_not_eligible_for_rfi", 409);
      }
      await c.query(`update orgs set state = 'rfi_required', updated_at = now() where id = $1`, [input.orgId]);
    }

    // Reuse an open rfi_relay case for this org, else open one (avoids a new case per round).
    const existing = await c.query<{ id: string }>(
      `select id from cases where org_id = $1 and type = 'rfi_relay' and status <> 'closed'
        order by opened_at desc limit 1`,
      [input.orgId],
    );
    const caseId =
      existing.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `insert into cases (org_id, type, priority, summary, opened_by)
           values ($1, 'rfi_relay', 'normal', 'Solicitação de informações (EDD)', $2) returning id`,
          [input.orgId, input.adminId],
        )
      ).rows[0]!.id;

    await postAdminCaseMessageOn(c, {
      caseId,
      authorAdminId: input.adminId,
      body: message,
      customerVisible: true, // rfi_relay is allowlisted; the wall check passes, notification fires
    });

    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'ops', $2, 'admission.rfi_relayed', $3)`,
      [input.orgId, input.adminId, JSON.stringify({ relay: true, caseId, authority: "avenia" })],
    );

    return { caseId, state: "rfi_required" };
  });
}
