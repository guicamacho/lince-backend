/**
 * Server-to-server guard for /admin/*.
 *
 * The admin app authenticates the staff member via its own (separate) Clerk
 * instance, then calls these endpoints with a shared service token. The approval
 * itself is a DB-gated change (recordAveniaVerdict), so Clerk auth happens in the
 * admin app — the backend just trusts the token (admin app is network-isolated).
 * Returns 503 if unconfigured, 401 on a bad/missing token.
 */
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

/** Constant-time compare — no early-exit timing oracle on the shared admin secret. */
function tokensMatch(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdminServiceToken(req: Request, res: Response, next: NextFunction): void {
  const token = env.adminServiceToken;
  if (!token) {
    res.status(503).json({ error: "admin_not_configured" });
    return;
  }
  if (!tokensMatch(req.header("x-admin-service-token") ?? "", token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
