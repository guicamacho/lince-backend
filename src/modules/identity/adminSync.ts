/**
 * Resolve a back-office staff member's `admin_users` row from their Clerk identity.
 *
 * The admin app authenticates staff via its OWN (separate) Clerk instance, then
 * passes the verified identity here over a service-token call. We upsert the
 * `admin_users` row (link by clerk_user_id, else by email, else create) and return
 * its id — used as `admission_recorded_by` on the relay. RBAC/roles is out of skeleton scope.
 */
import { pool } from "../../db/pool.js";

export async function ensureAdminUser(clerkUserId: string, email: string, name: string): Promise<string> {
  const e = email.trim().toLowerCase();
  const linked = await pool.query<{ id: string }>("select id from admin_users where clerk_user_id = $1", [clerkUserId]);
  if (linked.rows[0]) return linked.rows[0].id;

  const byEmail = await pool.query<{ id: string }>("select id from admin_users where lower(email) = $1 limit 1", [e]);
  if (byEmail.rows[0]) {
    await pool.query("update admin_users set clerk_user_id = $2, name = $3, updated_at = now() where id = $1", [
      byEmail.rows[0].id,
      clerkUserId,
      name || e,
    ]);
    return byEmail.rows[0].id;
  }

  const created = await pool.query<{ id: string }>(
    "insert into admin_users (clerk_user_id, email, name) values ($1,$2,$3) returning id",
    [clerkUserId, e, name || e],
  );
  return created.rows[0]!.id;
}
