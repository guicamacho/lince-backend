/**
 * Staff roster + role management (superadmin only). The roles here are what requireAdminRole
 * enforces per route (PRD-04 §1). A lockout guard refuses to strip the last active superadmin.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

export const VALID_ADMIN_ROLES = new Set(["superadmin", "compliance", "support", "treasury_ops", "read_only"]);

export async function listAdmins() {
  const { rows } = await pool.query(
    `select id, email, name, roles, is_active, created_at from admin_users order by created_at asc`,
  );
  return rows;
}

/** Set an admin's roles (superadmin action). Unknown roles are dropped; can't orphan the system. */
export async function setAdminRoles(targetAdminId: string, roles: string[], actorAdminId: string) {
  const clean = [...new Set(roles.filter((r) => VALID_ADMIN_ROLES.has(r)))];

  return withTransaction(async (c) => {
    // Serialize ALL role changes on one advisory lock so the last-superadmin count below can't
    // write-skew: two concurrent demotions of different superadmins would otherwise each see the
    // other still-superadmin and both commit, leaving zero. (Row FOR UPDATE locks only the target.)
    await c.query(`select pg_advisory_xact_lock(hashtext('admin-roster'))`);
    const cur = await c.query<{ roles: string[] }>(
      `select roles from admin_users where id = $1 for update`,
      [targetAdminId],
    );
    if (!cur.rows[0]) throw new HttpError("admin_not_found", 404);

    // Lockout guard: don't remove superadmin from the last active superadmin in the system.
    const losingSuperadmin = cur.rows[0].roles.includes("superadmin") && !clean.includes("superadmin");
    if (losingSuperadmin) {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from admin_users where is_active = true and 'superadmin' = any(roles) and id <> $1`,
        [targetAdminId],
      );
      if (Number(rows[0]!.n) === 0) throw new HttpError("cannot_remove_last_superadmin", 409);
    }

    const upd = await c.query<{ id: string; email: string; name: string; roles: string[]; is_active: boolean }>(
      `update admin_users set roles = $2, updated_at = now() where id = $1
       returning id, email, name, roles, is_active`,
      [targetAdminId, clean],
    );
    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload) values (null, 'ops', $1, 'admin.roles_changed', $2)`,
      [actorAdminId, JSON.stringify({ targetAdminId, from: cur.rows[0].roles, to: clean })],
    );
    return upd.rows[0];
  });
}
