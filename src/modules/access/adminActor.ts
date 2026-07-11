/**
 * Admin staff identity + RBAC (PRD-08 §5.1 remediation).
 *
 * The old model trusted the acting admin's identity from request-body fields over a shared
 * service token — so a token holder could claim to be any admin, which defeats maker-checker
 * (fake two identities) and makes admin_users.roles unenforceable. This binds the actor to a
 * VERIFIED admin Clerk session token and reads roles from the DB.
 *
 * Mode is gated on ADMIN_CLERK_SECRET_KEY so dev keeps working:
 *   - VERIFIED (secret set): the admin app forwards its session JWT (Authorization: Bearer). We
 *     verify it against the admin Clerk instance, resolve/provision the admin_users row by the
 *     VERIFIED clerk_user_id, and enforce roles. No token / bad token / inactive admin -> 401/403.
 *   - LEGACY (secret unset): fall back to the body-supplied identity (ensureAdminUser). RBAC is
 *     not enforced (roles unknown). This is the documented limitation until the secret is set.
 */
import type { Request, Response, NextFunction } from "express";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { env } from "../../config/env.js";
import { ensureAdminUser } from "../identity/adminSync.js";

export type AdminRole = "superadmin" | "compliance" | "support" | "treasury_ops" | "read_only";

export interface AdminActor {
  adminId: string;
  roles: string[];
  verified: boolean;
}

/** Fetch email + display name for a verified admin Clerk user (first-login provisioning). */
export type AdminUserFetch = (clerkUserId: string) => Promise<{ email: string; name: string }>;
const clerkAdminUserFetch: AdminUserFetch = async (clerkUserId) => {
  const client = createClerkClient({ secretKey: env.adminClerk.secretKey! });
  const user = await client.users.getUser(clerkUserId);
  const email = (user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "").toLowerCase();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email;
  return { email, name };
};

/** Resolve (and in verified mode provision) the admin_users row for a verified Clerk user id.
 *  `fetchUser` is injectable for tests. */
export async function resolveVerifiedAdmin(
  clerkUserId: string,
  fetchUser: AdminUserFetch = clerkAdminUserFetch,
): Promise<AdminActor> {
  const found = await pool.query<{ id: string }>(`select id from admin_users where clerk_user_id = $1`, [clerkUserId]);
  let adminId = found.rows[0]?.id;

  if (!adminId) {
    // First verified login: fetch the real email/name from the admin Clerk instance and provision.
    // Roles start EMPTY (no privileges) unless the email is a bootstrap superadmin — a superadmin
    // then grants roles to everyone else. Safe: identity is verified + the admin Clerk instance is
    // login-only. NOTE ensureAdminUser may RELINK an existing row by email (rehire) — is_active is
    // re-checked below so an offboarded row can't be resurrected implicitly.
    const { email, name } = await fetchUser(clerkUserId);
    if (!email) throw new HttpError("admin_no_email", 403);
    adminId = await ensureAdminUser(clerkUserId, email, name);
    // Bootstrap superadmin — but only for an ACTIVE row (never grant to an offboarded/inactive one).
    if (env.adminClerk.superadminEmails.includes(email)) {
      await pool.query(
        `update admin_users set roles = (select array(select distinct unnest(roles || array['superadmin'])))
          where id = $1 and is_active = true`,
        [adminId],
      );
    }
  }

  // Canonical read — is_active enforced on EVERY path (found, relinked, provisioned, bootstrapped).
  // Reactivation is an explicit ops action, never an implicit side-effect of login/relink.
  const row = await pool.query<{ roles: string[]; is_active: boolean }>(
    `select roles, is_active from admin_users where id = $1`,
    [adminId],
  );
  if (!row.rows[0] || !row.rows[0].is_active) throw new HttpError("admin_inactive", 403);
  return { adminId, roles: row.rows[0].roles, verified: true };
}

/**
 * Middleware: after the service-token guard, resolve the acting admin onto res.locals.
 * VERIFIED mode requires a valid forwarded session token; LEGACY mode uses the body identity
 * (writes) or leaves it unset (reads). Sets res.locals.adminActor.
 */
export async function requireAdminActor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (env.adminClerk.secretKey) {
      const auth = req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) throw new HttpError("admin_session_required", 401);
      let sub: string;
      try {
        const claims = await verifyToken(token, { secretKey: env.adminClerk.secretKey });
        sub = String(claims.sub);
      } catch {
        throw new HttpError("admin_session_invalid", 401);
      }
      res.locals.adminActor = await resolveVerifiedAdmin(sub, clerkAdminUserFetch);
    } else {
      // Legacy: identity from the body for write routes; reads don't need it.
      const b = (req.body ?? {}) as { adminClerkUserId?: unknown; adminEmail?: unknown; adminName?: unknown };
      if (b.adminClerkUserId && b.adminEmail) {
        const adminId = await ensureAdminUser(String(b.adminClerkUserId), String(b.adminEmail), String(b.adminName ?? ""));
        res.locals.adminActor = { adminId, roles: [], verified: false } as AdminActor;
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Baseline access gate (verified mode): a verified admin with ZERO roles has authenticated but
 * been granted nothing — deny ALL gated /admin routes (incl. reads, which carry customer PII)
 * until a superadmin assigns a role. Legacy mode stays permissive. Mounted right after
 * requireAdminActor so it covers every admin route, not just the role-gated writes.
 */
export function requireAdminAccess(_req: Request, res: Response, next: NextFunction): void {
  const actor = res.locals.adminActor as AdminActor | undefined;
  if (actor?.verified && actor.roles.length === 0) {
    next(new HttpError("no_admin_role", 403));
    return;
  }
  next();
}

/** The resolved admin id, or 400 if a write route ran without an identity (legacy misconfig). */
export function actingAdminId(res: Response): string {
  const actor = res.locals.adminActor as AdminActor | undefined;
  if (!actor) throw new HttpError("missing_admin_identity", 400);
  return actor.adminId;
}

/**
 * Route RBAC. In VERIFIED mode the actor must hold one of `allowed` (superadmin always passes);
 * a missing role -> 403. In LEGACY mode roles are unknown, so this is permissive (identity is
 * still whatever the body claimed) — enforcement activates when ADMIN_CLERK_SECRET_KEY is set.
 */
export function requireAdminRole(...allowed: AdminRole[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const actor = res.locals.adminActor as AdminActor | undefined;
    if (!actor?.verified) {
      next(); // legacy mode: cannot enforce; documented limitation
      return;
    }
    if (actor.roles.includes("superadmin") || actor.roles.some((r) => (allowed as string[]).includes(r))) {
      next();
      return;
    }
    next(new HttpError("insufficient_role", 403));
  };
}
