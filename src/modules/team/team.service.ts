/**
 * Team management (PRD-03 F1/F3/F7) — invite, change role, remove, transfer ownership.
 *
 * Rules enforced here (route-level requirePermission gates WHO may call; this module guards
 * WHAT is legal):
 *  - the role picker set is admin/finance/viewer — `owner` is never assignable (transfer only);
 *  - the owner is protected: cannot be demoted or removed, by anyone, including themselves;
 *  - KYB tags (legal_rep/ubo/director) on a member are inert and PRESERVED across role changes;
 *  - every roles mutation takes the row lock first (PRD-07 §2 pattern 10 — text[] read-modify-
 *    write races lose updates otherwise); ownership transfer is one tx, demote-then-promote
 *    (the uq_one_owner_per_org partial index is checked per statement);
 *  - no external call while holding a lock: the Clerk invitation is sent AFTER the invite row
 *    commits, with a compensating delete if delivery fails.
 */
import type pg from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { ACCESS_ROLES, accessRoles, type AccessRole } from "../access/permissions.js";

export type AssignableRole = Exclude<AccessRole, "owner">;
const ASSIGNABLE: readonly AssignableRole[] = ["admin", "finance", "viewer"];

/** Min seconds between invitation emails to one person (anti-spam; PRD-03 F1). Kept in sync
 *  with the customer app's resend countdown. */
export const INVITE_COOLDOWN_SECONDS = 60;

export interface TeamMember {
  personId: string;
  name: string;
  email: string;
  /** Access roles only — KYB tags are never surfaced (PRD-03 §5). */
  roles: AccessRole[];
  status: "invited" | "active" | "suspended";
}

export async function listMembers(orgId: string): Promise<TeamMember[]> {
  const { rows } = await pool.query<{
    person_id: string; full_name: string; email: string; roles: string[]; status: TeamMember["status"];
  }>(
    `select op.person_id, p.full_name, p.email, op.roles, op.status
       from org_people op
       join people p on p.id = op.person_id
      where op.org_id = $1
      order by ('owner' = any(op.roles)) desc, op.created_at asc`,
    [orgId],
  );
  return rows
    .map((r) => ({
      personId: r.person_id,
      name: r.full_name,
      email: r.email,
      roles: accessRoles(r.roles),
      status: r.status,
    }))
    // ponytail: pure-KYB rows (non-login UBOs, no access role) are compliance records, not
    // team members — hide them from the Team screen.
    .filter((m) => m.roles.length > 0);
}

function assertAssignable(role: string): asserts role is AssignableRole {
  if (!ASSIGNABLE.includes(role as AssignableRole)) throw new HttpError("role_not_assignable", 422);
}

/**
 * Claim the per-person invite-email cooldown slot atomically: sets last_invited_at=now() only if
 * the cooldown has elapsed. `claimed` is false when within cooldown. `previous` is the timestamp
 * before the claim (for restore if the send then fails, so a transient failure doesn't burn the
 * cooldown). The conditional UPDATE also serialises concurrent sends — only one wins the slot.
 */
async function claimInviteCooldown(
  q: Pick<pg.PoolClient, "query">,
  personId: string,
): Promise<{ claimed: boolean; previous: Date | null }> {
  const { rows } = await q.query<{ previous: Date | null }>(
    `with prev as (select last_invited_at from people where id = $1)
     update people set last_invited_at = now()
      where id = $1 and (last_invited_at is null or last_invited_at <= now() - make_interval(secs => $2))
      returning (select last_invited_at from prev) as previous`,
    [personId, INVITE_COOLDOWN_SECONDS],
  );
  return rows[0] ? { claimed: true, previous: rows[0].previous } : { claimed: false, previous: null };
}

/** Undo a cooldown claim (send failed) so a legit retry isn't blocked for the full window. */
async function restoreInviteCooldown(q: Pick<pg.PoolClient, "query">, personId: string, previous: Date | null) {
  await q.query(`update people set last_invited_at = $2 where id = $1`, [personId, previous]);
}

async function audit(c: Pick<pg.PoolClient, "query">, orgId: string, actorPersonId: string, event: string, payload: unknown) {
  await c.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload) values ($1, 'user', $2, $3, $4)`,
    [orgId, actorPersonId, event, JSON.stringify(payload)],
  );
}

/**
 * F1 — invite by email + one assignable role.
 *  - email already an org member -> 409 already_member;
 *  - existing login person WITH a Clerk account (multi-org) -> new org_people row, status
 *    'active' immediately (they can already sign in; no Clerk invitation);
 *  - otherwise create/reuse the person row and an 'invited' membership, then send the Clerk
 *    invitation. clerkSync flips invited->active when the accepted signup links clerk_user_id.
 */
export async function inviteMember(
  orgId: string,
  actorPersonId: string,
  input: { email?: unknown; role?: unknown },
  sendClerkInvitation: (email: string) => Promise<void>,
): Promise<TeamMember> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const role = String(input.role ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError("invalid_email", 422);
  assertAssignable(role);

  const created = await withTransaction(async (c) => {
    const person = await c.query<{ id: string; full_name: string; clerk_user_id: string | null }>(
      `select id, full_name, clerk_user_id from people where lower(email) = $1 and can_login = true limit 1`,
      [email],
    );
    let personId = person.rows[0]?.id;
    const hasClerkAccount = !!person.rows[0]?.clerk_user_id;
    if (!personId) {
      // Concurrent invite of the same brand-new email: both miss the SELECT above, the second
      // insert hits people_email_uq (unique on lower(email) where can_login). Under a SAVEPOINT
      // so the 23505 doesn't poison the tx (25P02) — then re-SELECT the row the winner inserted
      // and continue; the org_people insert below still 409s on (org_id, person_id).
      await c.query("savepoint invite_person");
      try {
        const ins = await c.query<{ id: string }>(
          // full_name placeholder until clerkSync refreshes it from the accepted signup
          `insert into people (full_name, email, can_login) values ($1, $2, true) returning id`,
          [email.split("@")[0]!, email],
        );
        personId = ins.rows[0]!.id;
        await c.query("release savepoint invite_person");
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e;
        await c.query("rollback to savepoint invite_person");
        const existing = await c.query<{ id: string }>(
          `select id from people where lower(email) = $1 and can_login = true limit 1`,
          [email],
        );
        personId = existing.rows[0]!.id;
      }
    }
    const status: TeamMember["status"] = hasClerkAccount ? "active" : "invited";
    // Only 'invited' members get an email — claim the cooldown slot BEFORE inserting the
    // membership so a cooldown-blocked invite leaves no dangling invited-but-never-emailed row.
    let cooldownPrev: Date | null = null;
    if (status === "invited") {
      const claim = await claimInviteCooldown(c, personId);
      if (!claim.claimed) throw new HttpError("invite_cooldown", 429);
      cooldownPrev = claim.previous;
    }
    const membership = await c.query<{ roles: string[]; status: TeamMember["status"] }>(
      `insert into org_people (org_id, person_id, roles, status) values ($1, $2, $3, $4)
       on conflict (org_id, person_id) do nothing
       returning roles, status`,
      [orgId, personId, [role], status],
    );
    if (!membership.rows[0]) throw new HttpError("already_member", 409);
    await audit(c, orgId, actorPersonId, "team.invited", { personId, email, role, status });
    return {
      personId,
      name: person.rows[0]?.full_name ?? email.split("@")[0]!,
      email,
      roles: [role] as AccessRole[],
      status,
      needsClerkInvitation: !hasClerkAccount,
      cooldownPrev,
    };
  });

  if (created.needsClerkInvitation) {
    try {
      await sendClerkInvitation(email);
    } catch {
      // compensate: an invite the invitee can never receive must not linger as a row, and the
      // cooldown it claimed is released so a retry of a transient failure isn't blocked 60s.
      await pool.query(`delete from org_people where org_id = $1 and person_id = $2 and status = 'invited'`, [
        orgId,
        created.personId,
      ]);
      await restoreInviteCooldown(pool, created.personId, created.cooldownPrev);
      throw new HttpError("invite_delivery_failed", 502);
    }
  }
  return { personId: created.personId, name: created.name, email: created.email, roles: created.roles, status: created.status };
}

/**
 * Resend the invitation email to a still-'invited' member (PRD-03 F1 retry). Cooldown-guarded
 * (per-person, anti-spam) via an atomic slot claim; sends a FRESH invite (revoke+recreate at the
 * Clerk layer). No membership mutation, so no lock — the conditional claim serialises concurrent
 * resends. `sendInvitation` is injected (tests stub it).
 */
export async function resendInvitation(
  orgId: string,
  actorPersonId: string,
  targetPersonId: string,
  sendInvitation: (email: string) => Promise<void>,
): Promise<void> {
  const { rows } = await pool.query<{ status: TeamMember["status"]; email: string }>(
    `select op.status, p.email from org_people op join people p on p.id = op.person_id
      where op.org_id = $1 and op.person_id = $2`,
    [orgId, targetPersonId],
  );
  const member = rows[0];
  if (!member) throw new HttpError("member_not_found", 404);
  if (member.status !== "invited") throw new HttpError("member_not_invited", 422);
  const claim = await claimInviteCooldown(pool, targetPersonId);
  if (!claim.claimed) throw new HttpError("invite_cooldown", 429);
  try {
    await sendInvitation(member.email);
  } catch {
    // release the just-claimed slot so a transient Clerk failure doesn't block retry for 60s
    await restoreInviteCooldown(pool, targetPersonId, claim.previous);
    throw new HttpError("invite_delivery_failed", 502);
  }
  await audit(pool, orgId, actorPersonId, "team.invitation_resent", { personId: targetPersonId, email: member.email });
}

/** Lock the target membership row; 404 if absent. Owner rows are protected for demote/remove. */
async function lockMembership(c: pg.PoolClient, orgId: string, personId: string) {
  const { rows } = await c.query<{ roles: string[]; status: TeamMember["status"] }>(
    `select roles, status from org_people where org_id = $1 and person_id = $2 for update`,
    [orgId, personId],
  );
  if (!rows[0]) throw new HttpError("member_not_found", 404);
  return rows[0];
}

/** F3 — set the member's single access role (KYB tags preserved). Owner is protected. */
export async function changeMemberRole(
  orgId: string,
  actorPersonId: string,
  targetPersonId: string,
  role: string,
): Promise<AccessRole[]> {
  assertAssignable(role);
  return withTransaction(async (c) => {
    const target = await lockMembership(c, orgId, targetPersonId);
    if (target.roles.includes("owner")) throw new HttpError("owner_protected", 403);
    const kybTags = target.roles.filter((r) => !ACCESS_ROLES.includes(r as AccessRole));
    const from = accessRoles(target.roles);
    const next = [...kybTags, role];
    await c.query(`update org_people set roles = $3 where org_id = $1 and person_id = $2`, [
      orgId,
      targetPersonId,
      next,
    ]);
    await audit(c, orgId, actorPersonId, "team.role_changed", { personId: targetPersonId, from, to: [role] });
    return [role] as AccessRole[];
  });
}

/**
 * F3 — remove a member (revokes the org_people row; PRD-03 F3). Owner is protected. If the removed
 * member was still 'invited', their pending Clerk invitation is revoked (best-effort) so state
 * doesn't dangle and a later re-invite starts clean. `revokeInvitations` is injected (tests stub it).
 */
export async function removeMember(
  orgId: string,
  actorPersonId: string,
  targetPersonId: string,
  revokeInvitations?: (email: string) => Promise<void>,
): Promise<void> {
  const removed = await withTransaction(async (c) => {
    const target = await lockMembership(c, orgId, targetPersonId);
    if (target.roles.includes("owner")) throw new HttpError("owner_protected", 403);
    const { rows } = await c.query<{ email: string }>(
      `delete from org_people where org_id = $1 and person_id = $2
       returning (select email from people where id = $2) as email`,
      [orgId, targetPersonId],
    );
    await audit(c, orgId, actorPersonId, "team.removed", {
      personId: targetPersonId,
      roles: accessRoles(target.roles),
    });
    return { wasInvited: target.status === "invited", email: rows[0]?.email ?? null };
  });
  if (removed.wasInvited && removed.email && revokeInvitations) await revokeInvitations(removed.email);
}

/**
 * F7 — transfer ownership to an existing ACTIVE admin. One tx, demote-then-promote in that
 * order (uq_one_owner_per_org is checked per statement). The route gates on
 * transfer_ownership (owner-only) + step-up.
 */
export async function transferOwnership(
  orgId: string,
  ownerPersonId: string,
  targetPersonId: string,
): Promise<void> {
  if (ownerPersonId === targetPersonId) throw new HttpError("cannot_transfer_to_self", 422);
  await withTransaction(async (c) => {
    // deterministic lock order across both rows — two concurrent transfers can't deadlock
    const first = ownerPersonId < targetPersonId ? ownerPersonId : targetPersonId;
    const second = ownerPersonId < targetPersonId ? targetPersonId : ownerPersonId;
    await lockMembership(c, orgId, first);
    await lockMembership(c, orgId, second);
    const owner = await c.query<{ roles: string[] }>(
      `select roles from org_people where org_id = $1 and person_id = $2`,
      [orgId, ownerPersonId],
    );
    if (!owner.rows[0]?.roles.includes("owner")) throw new HttpError("not_owner", 403);
    const target = await c.query<{ roles: string[]; status: string }>(
      `select roles, status from org_people where org_id = $1 and person_id = $2`,
      [orgId, targetPersonId],
    );
    if (!target.rows[0] || target.rows[0].status !== "active" || !target.rows[0].roles.includes("admin")) {
      throw new HttpError("transfer_target_must_be_active_admin", 422);
    }
    // demote: owner -> admin (KYB tags ride along)
    await c.query(
      `update org_people set roles = array_replace(roles, 'owner', 'admin') where org_id = $1 and person_id = $2`,
      [orgId, ownerPersonId],
    );
    // promote: admin -> owner
    await c.query(
      `update org_people set roles = array_replace(roles, 'admin', 'owner') where org_id = $1 and person_id = $2`,
      [orgId, targetPersonId],
    );
    await audit(c, orgId, ownerPersonId, "ownership.transferred", { from: ownerPersonId, to: targetPersonId });
  });
}
