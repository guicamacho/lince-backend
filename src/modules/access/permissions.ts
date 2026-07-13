/**
 * Customer-side RBAC (PRD-03 §1) — Clerk authenticates, THIS decides what a member can do.
 *
 * `org_people.roles` mixes ACCESS roles (owner/admin/finance/viewer) with inert KYB tags
 * (legal_rep/ubo/director). The permission layer evaluates ONLY the access subset (PRD-03 §5);
 * a KYB tag alone grants nothing. Roles are additive across the set. Enforcement is
 * server-side only — the client renders from GET /app/me but never authorizes.
 */
import type { Request, Response, NextFunction } from "express";

export const ACCESS_ROLES = ["owner", "admin", "finance", "viewer"] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export type Permission =
  | "view_dashboard"
  | "view_transactions"
  | "manage_beneficiaries"
  | "initiate_payout"
  | "respond_cases"
  | "enable_rails"
  | "manage_team"
  | "manage_roles"
  | "manage_settings"
  | "manage_billing"
  | "add_org"
  | "transfer_ownership";

// PRD-03 §1 matrix, verbatim. owner === admin + transfer_ownership (+ protection, enforced
// in team.service, not here).
const OWNER_ADMIN = ["owner", "admin"] as const;
const MONEY = ["owner", "admin", "finance"] as const;
const ALL = ACCESS_ROLES;
const MATRIX: Record<Permission, readonly AccessRole[]> = {
  view_dashboard: ALL,
  view_transactions: ALL,
  manage_beneficiaries: MONEY,
  initiate_payout: MONEY,
  respond_cases: MONEY, // reply to compliance/RFI threads + upload docs — never the read-only viewer
  enable_rails: OWNER_ADMIN,
  manage_team: OWNER_ADMIN,
  manage_roles: OWNER_ADMIN,
  manage_settings: OWNER_ADMIN,
  manage_billing: OWNER_ADMIN,
  add_org: OWNER_ADMIN,
  transfer_ownership: ["owner"],
};

/** The access-role subset of a raw org_people.roles array (KYB tags dropped by construction). */
export function accessRoles(roles: readonly string[]): AccessRole[] {
  return ACCESS_ROLES.filter((r) => roles.includes(r));
}

export function can(roles: readonly string[], permission: Permission): boolean {
  const access = accessRoles(roles);
  return MATRIX[permission].some((r) => access.includes(r));
}

/** 403 unless the caller's active-org roles (set by the /app gate on res.locals) allow it. */
export function requirePermission(permission: Permission) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const roles = (res.locals.roles ?? []) as string[];
    if (!can(roles, permission)) {
      res.status(403).json({ error: "forbidden", permission });
      return;
    }
    next();
  };
}
