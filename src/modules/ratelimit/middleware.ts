/**
 * rateLimit(routeClass) — Express middleware over the RateLimiter port (WP-B13).
 *
 * Mirrors the requireStepUp seam: `enforced` defaults to the RATE_LIMIT_ENFORCED flag
 * (off unless exactly "true"), so dev/tests aren't throttled; Wave 2 passes
 * env.rateLimit.enforced explicitly. For each rule in the class it keys by the rule's
 * scope, increments that window, and 429s on the first tier that trips.
 *
 * 429 body is neutral pt-BR — it never reveals the limit shape (ground rule 4).
 */
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { PostgresRateLimiter, type RateLimiter } from "./port.js";
import { ROUTE_CLASS_RULES, type RouteClass, type KeyScope } from "./routeClasses.js";

const defaultLimiter = new PostgresRateLimiter();

/** The identity a rule keys on; null ⇒ this scope's identity is absent for this request. */
function keyFor(scope: KeyScope, req: Request, res: Response): string | null {
  switch (scope) {
    case "user":
      return getAuth(req).userId ?? null;
    case "org":
      // The /app gate sets res.locals.orgId (the Lince org UUID) before route middleware runs.
      return (res.locals.orgId as string | undefined) ?? null;
    case "admin": {
      // requireAdminActor runs on the /admin mount BEFORE route middleware, so in verified
      // mode the acting admin is known here — key per admin, not per IP (PRD-07: one hot
      // admin must not throttle the rest of ops). Legacy mode / reads without a body
      // identity fall back to IP; NEVER null (a missing IP shares one capped bucket).
      const actor = res.locals.adminActor as { adminId?: string } | undefined;
      return actor?.adminId ?? req.ip ?? "unknown-ip";
    }
    case "ip":
      // Real client IP needs `trust proxy` set to the exact hop count (app.ts). Fall back to a
      // shared bucket, never null, so an IP tier can't be bypassed by an absent/again-null IP.
      return req.ip ?? "unknown-ip";
  }
}

export function rateLimit(
  routeClass: RouteClass,
  enforced = process.env.RATE_LIMIT_ENFORCED === "true",
  limiter: RateLimiter = defaultLimiter,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!enforced || routeClass === "webhook_exempt") {
      next();
      return;
    }
    for (const rule of ROUTE_CLASS_RULES[routeClass]) {
      const id = keyFor(rule.scope, req, res);
      if (id == null) continue; // can't identify this scope ⇒ skip this tier (primary tiers still apply)
      const key = `${rule.scope}:${id}`;
      const { allowed, retryAfter } = await limiter.check(key, routeClass, rule.limit, rule.windowSeconds);
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limited", message: "Muitas tentativas — tente novamente em instantes" });
        return;
      }
    }
    next();
  };
}
