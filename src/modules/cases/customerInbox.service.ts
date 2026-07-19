/**
 * Customer inbox — the read/reply surface behind the /app gate (org implicit via
 * res.locals.orgId). L4 of the tipping-off model: every read is org-scoped and returns ONLY
 * customer_visible=true messages on allowlisted-type cases; internal notes are never
 * serialized to a customer.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { enqueueNotification } from "../notifications/outbox.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../http/error.js";
import { UUID_RE } from "./cases.service.js";
import { CUSTOMER_FACING_CASE_TYPES } from "./messages.service.js";

const ALLOWLISTED = [...CUSTOMER_FACING_CASE_TYPES];
const MAX_REPLY_LEN = 4000;

// Tipping-off L5: the customer must never see internal workflow states (in_review / escalated),
// which would signal heightened scrutiny. Coarsen every customer-facing status to a neutral
// two-state view — a case is either still open ("em andamento") or closed ("concluído").
function customerStatus(status: string): "open" | "closed" {
  return status === "closed" ? "closed" : "open";
}

// Trust-boundary sanitizer (PRD-06 §2D: no user-provided links or HTML ever render). Strip
// tags, neutralise URLs, cap length. The frontend also escapes; this is the server wall.
function sanitizeReply(raw: string): string {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, " ")                                // strip HTML tags
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removido]") // neutralise URLs
    .trim()
    .slice(0, MAX_REPLY_LEN);
}

export async function listNotificationsForOrg(orgId: string) {
  const { rows } = await pool.query(
    `select id, kind, case_id, title, body, read_at, created_at
       from customer_notifications where org_id = $1 order by created_at desc limit 100`,
    [orgId],
  );
  const { rows: u } = await pool.query<{ unread: number }>(
    `select count(*)::int as unread from customer_notifications where org_id = $1 and read_at is null`,
    [orgId],
  );
  return { notifications: rows, unread: u[0]!.unread };
}

// Org-scoped (D4: org-level read state) + idempotent (coalesce keeps the first read time).
// Cross-org rows can never be touched — the WHERE org_id is the isolation.
export async function markNotificationRead(orgId: string, notificationId: string): Promise<{ ok: true }> {
  if (!UUID_RE.test(notificationId)) throw new HttpError("notification_not_found", 404);
  const { rowCount } = await pool.query(
    `update customer_notifications set read_at = coalesce(read_at, now())
      where id = $1 and org_id = $2`,
    [notificationId, orgId],
  );
  if (!rowCount) throw new HttpError("notification_not_found", 404);
  return { ok: true };
}

export async function listCustomerCasesForOrg(orgId: string) {
  const { rows } = await pool.query(
    `select c.id, c.type, c.status, c.opened_at, c.closed_at,
            (select max(m.created_at) from case_messages m
              where m.case_id = c.id and m.customer_visible = true) as last_message_at
       from cases c
      where c.org_id = $1 and c.type = any($2)
      order by c.opened_at desc
      limit 100`,
    [orgId, ALLOWLISTED],
  );
  return rows.map((r) => ({ ...r, status: customerStatus(r.status) }));
}

/** The org's open RFI thread, readable during onboarding (pre-active) — the ONE
 *  correspondence type that must reach a non-active org (EDD info request relay).
 *  Returns {case:null} when there's no open rfi_relay case. */
export async function getOpenRfiThreadForOrg(orgId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `select id from cases where org_id = $1 and type = 'rfi_relay' and status <> 'closed'
      order by opened_at desc limit 1`,
    [orgId],
  );
  if (!rows[0]) return { case: null, messages: [] as unknown[] };
  return getCaseThreadForOrg(orgId, rows[0].id);
}

export async function getCaseThreadForOrg(orgId: string, caseId: string) {
  if (!UUID_RE.test(caseId)) throw new HttpError("case_not_found", 404);
  const { rows } = await pool.query(
    `select id, type, status, opened_at, closed_at
       from cases where id = $1 and org_id = $2 and type = any($3)`,
    [caseId, orgId, ALLOWLISTED],
  );
  const caseRow = rows[0];
  if (!caseRow) throw new HttpError("case_not_found", 404);
  caseRow.status = customerStatus(caseRow.status); // L5 — never surface in_review/escalated
  // L4 — customer sees ONLY customer_visible messages, and never author_id (no staff-id leak).
  const { rows: messages } = await pool.query(
    `select id, case_id, author_type, body, created_at
       from case_messages
      where case_id = $1 and customer_visible = true
      order by created_at asc`,
    [caseId],
  );
  return { case: caseRow, messages };
}

export async function postCustomerCaseReply(
  orgId: string,
  clerkUserId: string | null,
  caseId: string,
  rawBody: string,
): Promise<{ id: string }> {
  if (!UUID_RE.test(caseId)) throw new HttpError("case_not_found", 404);
  const body = sanitizeReply(rawBody);
  if (!body) throw new HttpError("empty_body", 400);

  return withTransaction(async (client) => {
    // Fetch by id+org first (any type) so cross-org is a 404 but a same-org non-allowlisted
    // case is a distinct 400 — per the frozen contract.
    const { rows } = await client.query<{ status: string; type: string }>(
      `select status, type from cases where id = $1 and org_id = $2 for update`,
      [caseId, orgId],
    );
    const c = rows[0];
    if (!c) throw new HttpError("case_not_found", 404);
    if (!CUSTOMER_FACING_CASE_TYPES.has(c.type)) throw new HttpError("case_not_open_to_reply", 400);
    if (c.status === "closed") throw new HttpError("case_closed", 409);

    // Attribute the reply to the replying person (people.id) via org membership — same pattern
    // as beneficiaries.service. Null if the Clerk user is not an org member (still a valid reply).
    const { rows: p } = await client.query<{ id: string }>(
      `select p.id from people p join org_people op on op.person_id = p.id
        where p.clerk_user_id = $1 and op.org_id = $2 limit 1`,
      [clerkUserId, orgId],
    );
    const ins = await client.query<{ id: string }>(
      `insert into case_messages (case_id, author_type, author_id, body, customer_visible)
       values ($1, 'customer', $2, $3, true) returning id`,
      [caseId, p[0]?.id ?? null, body],
    );
    return { id: ins.rows[0]!.id };
  });
}

/**
 * Dispute intake (PRD-04 §13.1, G10) — the first CUSTOMER-ORIGINATED case type. In-app
 * "report a problem" on one of the org's transactions -> a customer_dispute case with the
 * complaint as the first (customer) message, a neutral ack email committing only to the
 * first-response SLA, and the SLA clock = cases.opened_at (first admin reply stops it —
 * surfaced to ops via listCases.first_admin_response_at).
 *
 * cases.opened_by stays NULL (it is an admin FK); authorship lives on the message row.
 * Reversal-ticket linkage is ON HOLD with Cluster 5 (question pack A2).
 */
export async function createDisputeForOrg(
  orgId: string,
  personId: string | null,
  input: { transactionId: string; message: string },
): Promise<{ caseId: string }> {
  const message = sanitizeReply(String(input.message ?? ""));
  if (!message) throw new HttpError("empty_body", 400);
  if (!UUID_RE.test(input.transactionId)) throw new HttpError("transaction_not_found", 404);
  return withTransaction(async (c) => {
    // The disputed transaction must belong to the org (404 keeps cross-org opaque).
    const tx = await c.query<{ id: string; type: string; created_at: string }>(
      `select id, type, created_at from org_transactions where id = $1 and org_id = $2`,
      [input.transactionId, orgId],
    );
    if (!tx.rows[0]) throw new HttpError("transaction_not_found", 404);

    // One open dispute per transaction: append to it instead of stacking cases.
    const open = await c.query<{ id: string }>(
      `select id from cases
        where org_id = $1 and type = 'customer_dispute' and status <> 'closed'
          and summary like '%' || $2 || '%'
        order by opened_at desc limit 1`,
      [orgId, shortRef(input.transactionId)],
    );
    let caseId = open.rows[0]?.id ?? null;
    const isNew = !caseId;
    if (!caseId) {
      const created = await c.query<{ id: string }>(
        `insert into cases (org_id, type, priority, summary)
         values ($1, 'customer_dispute', 'high', $2) returning id`,
        [orgId, `Contestação de transação ${shortRef(input.transactionId)}`],
      );
      caseId = created.rows[0]!.id;
    }
    await c.query(
      `insert into case_messages (case_id, author_type, author_id, body, customer_visible)
       values ($1, 'customer', $2, $3, true)`,
      [caseId, personId, message],
    );
    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'user', $2, 'dispute.opened', $3)`,
      [orgId, personId, JSON.stringify({ caseId, transactionId: input.transactionId, appended: !isNew })],
    );
    if (isNew) {
      await enqueueNotification(c, {
        eventType: "dispute_received_ack",
        recipientRef: orgId,
        templateId: "dispute_received_ack",
        payload: { slaPrazo: slaPrazoLabel(env.sla.disputeFirstResponseHours) },
      });
    }
    return { caseId: caseId! };
  });
}

/** Wall-clock prazo label: "24 horas" / "1 dia" / "2 dias" — never "úteis" (the commitment
 *  is wall-clock; business-day math is reserved for IFTI/SMR). */
function slaPrazoLabel(hours: number): string {
  if (hours <= 24) return `${hours} horas`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? "1 dia" : `${days} dias`;
}

/** Last 8 of the tx id — enough to reference a transaction in a case summary without a schema change.
 *  ponytail: a cases.transaction_id column is the upgrade path if disputes need hard joins. */
function shortRef(txId: string): string {
  return txId.replace(/-/g, "").slice(-8);
}
