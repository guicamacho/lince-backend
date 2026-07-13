/**
 * Route-class registry (WP-B13). Two things live here, both plain data:
 *   1. ROUTE_CLASS_RULES — the fixed-window budget(s) for each class.
 *   2. ROUTE_CLASSMAP + RATE_LIMIT_EXEMPT — which mounted route is which class.
 *
 * The CI gate (test/routeClassRegistry.test.ts) walks the real Express router and
 * fails if any route is neither classified nor exempt (PRD-07 §4 AC#1).
 *
 * All limits are PROVISIONAL starting values (PRD-07 §1), flagged pending Avenia #10.
 */

export type KeyScope = "user" | "org" | "admin" | "ip";

export interface RateRule {
  limit: number;
  windowSeconds: number;
  /** Which identity the counter is keyed on. */
  scope: KeyScope;
}

export type RouteClass =
  | "signup_start"
  | "cnpj_lookup"
  | "quote"
  | "ticket"
  | "beneficiary_write"
  | "reads"
  | "admin_export"
  | "webhook_exempt";

/**
 * Per-class budgets. A class may carry more than one rule (per-minute AND per-day);
 * "either trips" — a request is limited if ANY of its rules is exceeded. `webhook_exempt`
 * has no rules (providers retry on 429, so we never throttle them — see middleware).
 */
export const ROUTE_CLASS_RULES: Record<Exclude<RouteClass, "webhook_exempt">, RateRule[]> = {
  signup_start:      [{ limit: 5,   windowSeconds: 60,     scope: "ip"    }, { limit: 20, windowSeconds: 86_400, scope: "ip"  }],
  cnpj_lookup:       [{ limit: 10,  windowSeconds: 60,     scope: "user"  }, { limit: 30, windowSeconds: 86_400, scope: "org" }],
  quote:             [{ limit: 30,  windowSeconds: 60,     scope: "org"   }],
  ticket:            [{ limit: 10,  windowSeconds: 60,     scope: "org"   }],
  beneficiary_write: [{ limit: 20,  windowSeconds: 3_600,  scope: "org"   }],
  reads:             [{ limit: 120, windowSeconds: 60,     scope: "user"  }],
  admin_export:      [{ limit: 10,  windowSeconds: 3_600,  scope: "admin" }],
};

/**
 * `METHOD path` (path exactly as Express registers it) -> class. Keep in lockstep with
 * the routes in app.ts; the CI gate turns a missing entry into a failing test.
 * Admin mutations map to `admin_export` provisionally — the only admin-scoped class the
 * PRD defines; a dedicated admin-write budget is a tuning question for the PRD owner.
 */
export const ROUTE_CLASSMAP: Record<string, RouteClass> = {
  "POST /onboarding/bootstrap": "signup_start",
  "POST /onboarding/launch-verification": "signup_start",
  "POST /onboarding/mock-verify": "signup_start",
  "GET /onboarding/rfi": "reads",
  "POST /onboarding/rfi/reply": "signup_start",
  "POST /onboarding/cnpj-lookup": "cnpj_lookup",
  "GET /onboarding/state": "reads",
  "GET /app/me": "reads",
  "GET /app/deposit-details": "reads",
  "POST /app/deposits": "beneficiary_write",
  "POST /app/convert": "ticket",
  "GET /app/transactions": "reads",
  "GET /app/balances": "reads",
  "GET /app/rates": "reads",
  "GET /app/beneficiaries": "reads",
  "POST /app/beneficiaries": "beneficiary_write",
  "GET /app/team": "reads",
  "POST /app/team/invitations": "beneficiary_write",
  "POST /app/team/members/:personId/resend": "beneficiary_write",
  "POST /app/team/members/:personId/role": "beneficiary_write",
  "DELETE /app/team/members/:personId": "beneficiary_write",
  "POST /app/team/transfer-ownership": "beneficiary_write",
  "GET /app/notifications": "reads",
  "POST /app/notifications/:id/read": "reads",
  "GET /app/cases": "reads",
  "GET /app/cases/:id/messages": "reads",
  "POST /app/cases/:id/messages": "beneficiary_write",
  "GET /app/cases/:id/documents": "reads",
  "POST /app/cases/:id/documents": "beneficiary_write",
  "POST /admin/cases": "admin_export",
  "GET /admin/cases": "admin_export",
  "GET /admin/cases/:id": "admin_export",
  "POST /admin/cases/:id/messages": "admin_export",
  "POST /admin/cases/:id/status": "admin_export",
  "POST /admin/cases/:id/assign": "admin_export",
  "GET /admin/admins": "admin_export",
  "POST /admin/admins/:id/roles": "admin_export",
  "GET /admin/orgs": "admin_export",
  "GET /admin/orgs/:id/documents": "admin_export",
  "GET /admin/transactions": "admin_export",
  "GET /admin/webhooks": "admin_export",
  "POST /admin/webhooks/:id/replay": "admin_export",
  "GET /admin/orgs/:id": "admin_export",
  "POST /admin/orgs/:id/verdict": "admin_export",
  "POST /admin/orgs/:id/rfi": "admin_export",
  "POST /admin/orgs/:id/access": "admin_export",
  "GET /admin/admissions/aging": "admin_export",
  "POST /admin/audit/export": "admin_export",
  "POST /admin/approvals": "admin_export",
  "GET /admin/approvals": "admin_export",
  "POST /admin/approvals/:id/decide": "admin_export",
  // Webhooks are classified but never throttled (providers retry). The class gives the
  // future volume-alarm a home; middleware short-circuits it to a no-op.
  "POST /webhooks/clerk": "webhook_exempt",
  "POST /webhooks/:provider": "webhook_exempt",
};

/** Routes that are never rate-limited at all (liveness must not throttle). */
export const RATE_LIMIT_EXEMPT = new Set<string>(["GET /healthz"]);

/**
 * Resolve a route to its class, "exempt", or null (unclassified — the CI gate fails on null).
 */
export function classifyRoute(method: string, path: string): RouteClass | "exempt" | null {
  const sig = `${method.toUpperCase()} ${path}`;
  if (RATE_LIMIT_EXEMPT.has(sig)) return "exempt";
  return ROUTE_CLASSMAP[sig] ?? null;
}
