/**
 * Maker-checker queue (A4) over `pending_approvals` (migration 0003). A gated action is
 * enqueued by one operator and commits only on a SECOND operator's approval.
 *
 * Three operations:
 *   enqueueApproval   — insert an open row (requested_by).
 *   listOpenApprovals — open rows (decided_at is null) ⋈ requester, oldest first.
 *   decideApproval    — CAS the open row to decided, enforce maker-checker (DB CHECK),
 *                       and — on approve — dispatch the executor INSIDE the same txn so the
 *                       approval and its side effect commit atomically.
 *
 * Session 5 wires ONE executor: org_block -> setOrgAccess(block). The other action_types
 * stay decision-only (a 501 guard) until their WPs. Approving an unwired type rolls the whole
 * decide back — you cannot record an approval you cannot execute.
 */
import type pg from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { setOrgAccess } from "../access/access.service.js";

export type ApprovalActionType = "admission_relay" | "org_block" | "reversal" | "role_grant";

export interface EnqueueApprovalInput {
  requestedByAdminId: string;
  actionType: ApprovalActionType;
  targetRef: string;
  payload?: Record<string, unknown>;
}

export interface EnqueuedApproval {
  id: string;
  action_type: string;
  target_ref: string;
  requested_at: Date;
}

export async function enqueueApproval(input: EnqueueApprovalInput): Promise<EnqueuedApproval> {
  const { rows } = await pool.query<EnqueuedApproval>(
    `insert into pending_approvals (action_type, target_ref, payload, requested_by)
     values ($1, $2, $3, $4)
     returning id, action_type, target_ref, requested_at`,
    [input.actionType, input.targetRef, JSON.stringify(input.payload ?? {}), input.requestedByAdminId],
  );
  return rows[0]!;
}

export async function listOpenApprovals(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `select pa.id, pa.action_type, pa.target_ref, pa.payload, pa.requested_at,
            au.name as requested_by_name, au.email as requested_by_email
       from pending_approvals pa
       join admin_users au on au.id = pa.requested_by
      where pa.decided_at is null
      order by pa.requested_at asc`,
  );
  return rows;
}

export interface DecideApprovalInput {
  id: string;
  decidedByAdminId: string;
  decision: "approved" | "declined";
  remark?: string;
}

export interface DecideApprovalResult {
  id: string;
  decision: string;
  decided_at: Date;
  executed: boolean;
}

interface DecidedRow {
  id: string;
  action_type: ApprovalActionType;
  target_ref: string;
  payload: Record<string, unknown>;
  decision: string;
  decided_at: Date;
}

// Dispatch an APPROVED action inside the caller's txn. org_block is the only wired executor
// in Session 5; everything else is a 501 guard until its WP lands.
async function execute(client: pg.PoolClient, row: DecidedRow, decidedByAdminId: string): Promise<void> {
  switch (row.action_type) {
    case "org_block":
      await setOrgAccess(
        {
          orgId: row.target_ref,
          action: "block",
          reason: String(row.payload?.reason ?? ""),
          source: "lince_operational",
          changedByAdminId: decidedByAdminId,
        },
        client,
      );
      return;
    default:
      throw new HttpError("executor_not_wired", 501);
  }
}

function isMakerCheckerViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null &&
    (e as { code?: string }).code === "23514" &&
    (e as { constraint?: string }).constraint === "pending_approvals_maker_checker"
  );
}

export async function decideApproval(input: DecideApprovalInput): Promise<DecideApprovalResult> {
  // Mirror /verdict: a decline must carry a reason.
  if (input.decision === "declined" && !String(input.remark ?? "").trim()) {
    throw new HttpError("remark_required_on_decline", 400);
  }

  return withTransaction(async (client) => {
    // CAS: only an OPEN row transitions. If the approver == the requester the DB CHECK
    // (decided_by <> requested_by) fires -> map to a 403; if the row is already decided
    // the WHERE matches nothing -> 409.
    let updated;
    try {
      updated = await client.query<DecidedRow>(
        `update pending_approvals
            set decided_by = $2, decided_at = now(), decision = $3, remark = $4
          where id = $1 and decided_at is null
          returning id, action_type, target_ref, payload, decision, decided_at`,
        [input.id, input.decidedByAdminId, input.decision, input.remark ?? null],
      );
    } catch (e) {
      if (isMakerCheckerViolation(e)) throw new HttpError("maker_checker_violation", 403);
      throw e;
    }
    if (updated.rowCount === 0) throw new HttpError("already_decided", 409);

    const row = updated.rows[0]!;
    let executed = false;
    if (row.decision === "approved") {
      await execute(client, row, input.decidedByAdminId);
      executed = true;
    }
    return { id: row.id, decision: row.decision, decided_at: row.decided_at, executed };
  });
}
