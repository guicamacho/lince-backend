/**
 * Org access control — the write path for the `orgs.access_status` seam (migration 0002).
 *
 * Suspend / block / reinstate an org's access WITHOUT touching its lifecycle `state`
 * (admission stays Avenia's — see admission.service.ts). Every change carries a
 * mandatory reason and lands in audit_log as `org.access_changed`.
 */
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

export type AccessAction = "suspend" | "block" | "reinstate";
export type AccessSource = "lince_operational" | "avenia_relay";

export interface SetOrgAccessInput {
  orgId: string;
  action: AccessAction;
  reason: string;
  source?: AccessSource; // defaults to lince_operational
  changedByAdminId: string; // admin_users.id of the acting ops user
}

// No transition guard: each action maps to an absolute target status. The set is
// flat (active/suspended/blocked) — any hop between them is legal.
const TARGET_STATUS: Record<AccessAction, string> = {
  suspend: "suspended",
  block: "blocked",
  reinstate: "active",
};

export async function setOrgAccess(input: SetOrgAccessInput): Promise<void> {
  const reason = input.reason.trim();
  // Compliance invariant: EVERY access change (including reinstate) records why.
  if (!reason) throw new HttpError("reason_required", 400);

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ access_status: string }>(
      `select access_status from orgs where id = $1 and deleted_at is null for update`,
      [input.orgId],
    );
    const from = rows[0]?.access_status;
    if (!from) throw new HttpError("org_not_found", 404);

    const to = TARGET_STATUS[input.action];
    const source = input.source ?? "lince_operational";
    await client.query(
      `update orgs
          set access_status = $2,
              access_reason = $3,
              access_source = $4,
              access_changed_by = $5,
              access_changed_at = now(),
              updated_at = now()
        where id = $1`,
      [input.orgId, to, reason, source, input.changedByAdminId],
    );

    await client.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'ops', $2, 'org.access_changed', $3)`,
      [
        input.orgId,
        input.changedByAdminId,
        JSON.stringify({ action: input.action, from, to, reason, source }),
      ],
    );
  });
}
