/**
 * Customer inbox — the read/reply surface behind the /app gate (org implicit via
 * res.locals.orgId). L4 of the tipping-off model: every read is org-scoped and returns ONLY
 * customer_visible=true messages on allowlisted-type cases; internal notes are never
 * serialized to a customer.
 */
import { pool, withTransaction } from "../../db/pool.js";
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
