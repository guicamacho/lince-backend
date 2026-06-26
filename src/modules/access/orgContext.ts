/**
 * Resolve the caller's org from their Clerk identity.
 * Modelo A: Clerk carries auth identity ONLY — the org/role data lives in our DB.
 */
import { pool } from "../../db/pool.js";

/**
 * The first ACTIVE org a Clerk user belongs to, via people.clerk_user_id -> org_people.
 * Returns null if the user maps to no active org. (Multi-org selection is a later concern;
 * Phase 1 customers are single-org.)
 */
export async function activeOrgForClerkUser(clerkUserId: string): Promise<string | null> {
  const { rows } = await pool.query<{ org_id: string }>(
    `select o.id as org_id
       from people p
       join org_people op on op.person_id = p.id
       join orgs o on o.id = op.org_id
      where p.clerk_user_id = $1
        and o.state = 'active'
        and o.deleted_at is null
      order by o.created_at asc
      limit 1`,
    [clerkUserId],
  );
  return rows[0]?.org_id ?? null;
}
