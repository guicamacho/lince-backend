/**
 * The ONE access gate. No app surface exists until org.state = 'active'.
 * Server-enforced, single middleware — there is no per-screen gating.
 * (Pre-active surfaces are the onboarding funnel only, handled outside this gate.)
 */
import { pool } from "../../db/pool.js";

export interface OrgAccessContext {
  orgId: string;
}

export async function isOrgActive(orgId: string): Promise<boolean> {
  const { rows } = await pool.query<{ state: string; access_status: string }>(
    "select state, access_status from orgs where id = $1 and deleted_at is null",
    [orgId],
  );
  // Access requires BOTH the lifecycle state and the access_status (suspend/block, mig 0002).
  return rows[0]?.state === "active" && rows[0]?.access_status === "active";
}

/**
 * Express-style guard. Swap `req`/`res`/`next` for your framework's primitives.
 * Returns 403 unless the caller's org is active.
 */
export function requireActiveOrg(getOrgId: (req: unknown) => string | undefined) {
  return async (req: unknown, res: { status: (n: number) => { end: () => void } }, next: () => void) => {
    const orgId = getOrgId(req);
    if (!orgId || !(await isOrgActive(orgId))) {
      res.status(403).end();
      return;
    }
    next();
  };
}
