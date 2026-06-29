/**
 * Pre-active onboarding state for the customer shell gate.
 *
 *  * `currentOrgForClerkUser` — the caller's org + state (ANY state), so the app
 *    shell can render the right onboarding screen / open the main menu.
 *  * `advanceCallerOrg` — moves the caller's org one legal step, enforced by the
 *    `assertTransition` guard. Used by launch-verification (-> kyb_in_progress)
 *    and mock-verify (-> vendor_pending). Money/real-Didit stay out of scope.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { assertTransition, type OrgState } from "../identity/org.state.js";
import { HttpError } from "../../http/error.js";

export interface OrgSnapshot {
  orgId: string;
  state: OrgState;
  admissionState: string;
}

const SELECT_CALLER_ORG = `
  select o.id, o.state, o.admission_state
    from people p
    join org_people op on op.person_id = p.id
    join orgs o on o.id = op.org_id
   where p.clerk_user_id = $1 and o.deleted_at is null
   order by o.created_at asc
   limit 1`;

export async function currentOrgForClerkUser(clerkUserId: string): Promise<OrgSnapshot | null> {
  const { rows } = await pool.query<{ id: string; state: OrgState; admission_state: string }>(SELECT_CALLER_ORG, [
    clerkUserId,
  ]);
  const r = rows[0];
  return r ? { orgId: r.id, state: r.state, admissionState: r.admission_state } : null;
}

export async function advanceCallerOrg(clerkUserId: string, to: OrgState): Promise<OrgSnapshot> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string; state: OrgState }>(
      `${SELECT_CALLER_ORG} for update of o`,
      [clerkUserId],
    );
    const org = rows[0];
    if (!org) throw new HttpError("no_org_for_user", 404);
    assertTransition(org.state, to); // throws on an illegal step

    // Moving to vendor_pending = the KYB-L1 forward to Avenia -> stamps the
    // aging clock (orgs_admission_pending_ix / PRD-04 §4.3).
    const stampForward = to === "vendor_pending";
    const upd = await c.query<{ state: OrgState; admission_state: string }>(
      `update orgs
          set state = $2,
              updated_at = now(),
              kyb_forwarded_at = case when $3 then now() else kyb_forwarded_at end
        where id = $1
        returning state, admission_state`,
      [org.id, to, stampForward],
    );
    return { orgId: org.id, state: upd.rows[0]!.state, admissionState: upd.rows[0]!.admission_state };
  });
}
