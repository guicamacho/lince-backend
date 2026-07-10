/**
 * Case messages — the correspondence write path + the tipping-off enforcement gate.
 *
 * The `case_messages.customer_visible` flag is the enforcement point (L2), wrapped by a
 * case-type allowlist above it (L1) and delivered through neutral copy below it (L3). This
 * is the free-text analogue of the outbox's `isSendable` template gate: both are pure, and
 * both refuse unsafe content before it can reach a customer.
 */
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { UUID_RE } from "./cases.service.js";

// L1 — case-type allowlist. Only these operational types may EVER carry a customer-visible
// message (D1/D3: rfi_relay + kyb_completeness for v1). customer_inquiry/customer_dispute are
// reserved for A2 (customer-initiated) and intentionally NOT here; avenia_decision_relay,
// manual_review, support, etc. can never reach the customer inbox — the tipping-off wall.
export const CUSTOMER_FACING_CASE_TYPES = new Set(["rfi_relay", "kyb_completeness"]);

// L2 — the pure message gate (the isSendable analogue). No DB, unit-tested. Defaults closed:
// customer_visible must be explicitly requested AND the case type must be allowlisted.
export function messageCanBeCustomerVisible(caseType: string, requested: boolean): boolean {
  return requested === true && CUSTOMER_FACING_CASE_TYPES.has(caseType);
}

// L3 — neutral pt-BR copy keyed by case type. NEVER the raw staff text (tipping-off-safe): the
// reviewed message body lives in the thread; the ping only says "there is an update, come look".
export const NEUTRAL_NOTIFICATION_COPY: Record<string, { title: string; body: string }> = {
  rfi_relay:        { title: "Atualização na sua solicitação", body: "Há uma atualização na sua solicitação. Acesse para ver os detalhes." },
  kyb_completeness: { title: "Atualização no seu cadastro",    body: "Há uma atualização no seu cadastro. Acesse para ver os detalhes." },
};

export interface PostAdminMessageInput {
  caseId: string;
  authorAdminId: string;
  body: string;
  customerVisible?: boolean;
}

/**
 * Post a staff message. In ONE transaction: (L1+L2) refuse a customer-visible message on a
 * non-allowlisted type; insert the message; (L3) if customer-visible, insert the neutral
 * notification directly in the same txn (NOT via the outbox — no network, so it is atomic
 * with the message and instantly visible); audit as an ops action.
 *
 * An internal note (customer_visible=false) inserts ONLY the message — no notification row,
 * invisible to the customer. That is the core guardrail.
 */
export async function postAdminCaseMessage(input: PostAdminMessageInput): Promise<{ id: string }> {
  return withTransaction((client) => postAdminCaseMessageOn(client, input));
}

/** Client-scoped variant — posts inside the CALLER's transaction so a composite action
 *  (e.g. raise-RFI: state change + case + message) commits atomically. Same wall (L1-L3). */
export async function postAdminCaseMessageOn(
  client: import("pg").PoolClient,
  input: PostAdminMessageInput,
): Promise<{ id: string }> {
  if (!UUID_RE.test(input.caseId)) throw new HttpError("case_not_found", 404);
  const body = String(input.body ?? "").trim();
  if (!body) throw new HttpError("empty_body", 400);
  const requested = input.customerVisible === true;

  {
    const { rows } = await client.query<{ type: string; org_id: string | null }>(
      `select type, org_id from cases where id = $1 for update`,
      [input.caseId],
    );
    const c = rows[0];
    if (!c) throw new HttpError("case_not_found", 404);

    // L1 + L2 — the wall. Staff opting a message customer-visible on a non-allowlisted type
    // (manual_review, avenia_decision_relay, …) is refused; nothing is written (txn rolls back).
    if (requested && !messageCanBeCustomerVisible(c.type, true)) {
      throw new HttpError("message_not_customer_visible_for_type", 400);
    }
    // A customer-visible message needs an org to notify. Guard so admin misuse is a clean 400,
    // not a customer_notifications NOT NULL 500. Customer-facing cases are org-scoped by design.
    if (requested && !c.org_id) throw new HttpError("case_has_no_org", 400);

    const ins = await client.query<{ id: string }>(
      `insert into case_messages (case_id, author_type, author_id, body, customer_visible)
       values ($1, 'admin', $2, $3, $4) returning id`,
      [input.caseId, input.authorAdminId, body, requested],
    );
    const messageId = ins.rows[0]!.id;

    // L3 — deliver the neutral ping in the SAME txn (exists iff the message commits). Never the
    // raw staff body. ponytail: a true mid-txn-failure rollback of both rows is guaranteed by
    // withTransaction (already covered by outbox acceptance #1); no extra failure injection here.
    if (requested) {
      const copy = NEUTRAL_NOTIFICATION_COPY[c.type]!;
      await client.query(
        `insert into customer_notifications (org_id, kind, case_id, title, body)
         values ($1, 'case_message', $2, $3, $4)`,
        [c.org_id, input.caseId, copy.title, copy.body],
      );
    }

    // Audit as an ops action (house style; matches admission.service).
    await client.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'ops', $2, 'case.message_posted', $3)`,
      [c.org_id, input.authorAdminId, JSON.stringify({ caseId: input.caseId, messageId, customerVisible: requested })],
    );
    return { id: messageId };
  }
}
