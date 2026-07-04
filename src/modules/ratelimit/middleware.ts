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
    case "admin":
      // Admin routes are service-token gated; the admin id lives in the request body (parsed
      // in the handler, not here). Key on the caller IP at this layer — provisional.
      return req.ip ?? null;
    case "ip":
      // Needs `trust proxy` set for the real client IP behind Fly (deployment/Wave 2 concern).
      return req.ip ?? null;
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
