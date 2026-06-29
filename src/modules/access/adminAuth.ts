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
import { env } from "../../config/env.js";

export function requireAdminServiceToken(req: Request, res: Response, next: NextFunction): void {
  const token = env.adminServiceToken;
  if (!token) {
    res.status(503).json({ error: "admin_not_configured" });
    return;
  }
  if (req.header("x-admin-service-token") !== token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
