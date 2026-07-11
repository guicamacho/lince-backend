/**
 * Resolve the caller's org membership from their Clerk identity.
 * Modelo A: Clerk carries auth identity ONLY — the org/role data lives in our DB.
 */
import { pool } from "../../db/pool.js";

export interface ActiveMembership {
  orgId: string;
  personId: string;
  /** Raw org_people.roles — access roles + inert KYB tags; filter via permissions.accessRoles. */
  roles: string[];
}

/**
 * The caller's membership in the first ACTIVE org, via people.clerk_user_id -> org_people.
 * Requires op.status='active': an invited-but-unaccepted or suspended member resolves to
 * nothing (PRD-03 §4). Returns null if no active membership. (Multi-org selection is a later
 * concern; Phase 1 customers are single-org.)
 */
export async function activeMembershipForClerkUser(clerkUserId: string): Promise<ActiveMembership | null> {
  const { rows } = await pool.query<{ org_id: string; person_id: string; roles: string[] }>(
    `select o.id as org_id, p.id as person_id, op.roles
       from people p
       join org_people op on op.person_id = p.id
       join orgs o on o.id = op.org_id
      where p.clerk_user_id = $1
        and op.status = 'active'
        and o.state = 'active'
        and o.access_status = 'active'
        and o.deleted_at is null
      order by o.created_at asc
      limit 1`,
    [clerkUserId],
  );
  const r = rows[0];
  return r ? { orgId: r.org_id, personId: r.person_id, roles: r.roles } : null;
}

/** Org id only — kept for callers/tests that predate the membership-shaped resolver. */
export async function activeOrgForClerkUser(clerkUserId: string): Promise<string | null> {
  return (await activeMembershipForClerkUser(clerkUserId))?.orgId ?? null;
}
