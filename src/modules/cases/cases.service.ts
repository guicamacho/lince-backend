/**
 * Compliance / ops cases — the staff-side CRUD over the `cases` table (0001 schema, 0006
 * operational taxonomy). Modelo A: OPERATIONAL types only; AML/SMR types are structurally
 * absent from the schema CHECK (counsel #1). This service pre-validates the type so an AML/
 * unknown type is a clean 400, not a DB 500 (mirrors admission.service's guard style).
 *
 * Reads use `pool.query`; the only write that must be atomic with a side effect (a
 * customer-visible message + its notification) lives in messages.service.ts.
 */
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

/** uuid v-any shape guard — malformed :id params become a clean 400/404, never a pg 22P02 500. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Operational case taxonomy — mirrors cases_type_check (migration 0006). The schema is the
// source of truth; this set is the second wall giving a clean 400 before the query.
export const OPERATIONAL_CASE_TYPES = new Set([
  "kyb_completeness", "avenia_decision_relay", "rfi_relay", "beneficiary_review",
  "support", "manual_review", "recon_break", "customer_dispute",
  "customer_inquiry", "dormant_review",
]);

const CASE_STATUSES = new Set(["open", "in_review", "escalated", "closed"]);
const CASE_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

export interface CreateCaseInput {
  orgId?: string | null;
  type: string;
  priority?: string;
  summary?: string;
  openedByAdminId: string;
}

export async function createCase(input: CreateCaseInput) {
  if (!OPERATIONAL_CASE_TYPES.has(input.type)) throw new HttpError("invalid_case_type", 400);
  if (input.orgId != null && !UUID_RE.test(input.orgId)) throw new HttpError("invalid_org", 400);
  const priority = input.priority ?? "normal";
  if (!CASE_PRIORITIES.has(priority)) throw new HttpError("invalid_priority", 400);
  const { rows } = await pool.query(
    `insert into cases (org_id, type, priority, summary, opened_by)
     values ($1, $2, $3, $4, $5)
     returning id, org_id, type, status, priority, summary, opened_at`,
    [input.orgId ?? null, input.type, priority, input.summary ?? null, input.openedByAdminId],
  );
  return rows[0];
}

export interface ListCasesFilter { type?: string; status?: string; orgId?: string }

export async function listCases(filter: ListCasesFilter = {}) {
  if (filter.orgId && !UUID_RE.test(filter.orgId)) throw new HttpError("invalid_org", 400);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.type)   { params.push(filter.type);   where.push(`c.type = $${params.length}`); }
  if (filter.status) { params.push(filter.status); where.push(`c.status = $${params.length}`); }
  if (filter.orgId)  { params.push(filter.orgId);  where.push(`c.org_id = $${params.length}`); }
  const clause = where.length ? `where ${where.join(" and ")}` : "";
  const { rows } = await pool.query(
    `select c.id, c.org_id, c.type, c.status, c.priority, c.summary, c.assigned_admin_id,
            c.opened_by, c.opened_at, c.closed_at,
            o.razao_social as org_name,
            (select max(m.created_at) from case_messages m where m.case_id = c.id) as last_message_at,
            (select min(m.created_at) from case_messages m
              where m.case_id = c.id and m.author_type = 'admin'
                and m.customer_visible = true) as first_admin_response_at
       from cases c
       left join orgs o on o.id = c.org_id
       ${clause}
      order by c.opened_at desc
      limit 200`,
    params,
  );
  return rows;
}

export async function getCaseDetail(caseId: string) {
  if (!UUID_RE.test(caseId)) throw new HttpError("case_not_found", 404);
  const { rows } = await pool.query(
    `select id, org_id, type, status, priority, summary, resolution,
            assigned_admin_id, opened_by, opened_at, closed_at
       from cases where id = $1`,
    [caseId],
  );
  const caseRow = rows[0];
  if (!caseRow) throw new HttpError("case_not_found", 404);
  let org = null;
  if (caseRow.org_id) {
    const { rows: o } = await pool.query(
      `select id, razao_social, '••••••••••' || right(cnpj, 4) as cnpj, state from orgs where id = $1`,
      [caseRow.org_id],
    );
    org = o[0] ?? null;
  }
  // Full thread incl. internal notes — staff are inside the boundary (L4 filter is customer-only).
  const { rows: messages } = await pool.query(
    `select id, case_id, author_type, author_id, body, customer_visible, created_at
       from case_messages where case_id = $1 order by created_at asc`,
    [caseId],
  );
  return { case: caseRow, org, messages };
}

export async function assignCase(caseId: string, assignedAdminId: string) {
  if (!UUID_RE.test(caseId)) throw new HttpError("case_not_found", 404);
  if (!UUID_RE.test(assignedAdminId)) throw new HttpError("invalid_admin", 400);
  const { rows: a } = await pool.query("select id from admin_users where id = $1", [assignedAdminId]);
  if (!a[0]) throw new HttpError("invalid_admin", 400);
  const { rows } = await pool.query(
    `update cases set assigned_admin_id = $2 where id = $1 returning id, assigned_admin_id`,
    [caseId, assignedAdminId],
  );
  if (!rows[0]) throw new HttpError("case_not_found", 404);
  return rows[0];
}

export interface UpdateCaseStatusInput { caseId: string; status: string; resolution?: string }

export async function updateCaseStatus(input: UpdateCaseStatusInput) {
  if (!UUID_RE.test(input.caseId)) throw new HttpError("case_not_found", 404);
  if (!CASE_STATUSES.has(input.status)) throw new HttpError("invalid_status", 400);
  if (input.status === "closed" && !String(input.resolution ?? "").trim()) {
    throw new HttpError("resolution_required_on_close", 400);
  }
  // Reopening (status → non-closed) clears the stale closed_at + resolution so a reopened case
  // never carries a closed date (which would also reach the customer thread).
  const { rows } = await pool.query(
    `update cases
        set status     = $2,
            resolution = case when $2 = 'closed' then $3 else null end,
            closed_at  = case when $2 = 'closed' then now() else null end
      where id = $1
      returning id, status, closed_at`,
    [input.caseId, input.status, input.status === "closed" ? String(input.resolution).trim() : null],
  );
  if (!rows[0]) throw new HttpError("case_not_found", 404);
  return rows[0];
}
