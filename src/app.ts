/**
 * Lince Phase 1 — HTTP entry (Express). Modular monolith; composition only, routes live in
 * src/routes/*:
 *
 *   Public:     GET /healthz              — liveness + DB ping (below)
 *   Onboarding: /onboarding/*             — routes/onboarding.ts (session, no active org needed)
 *   Intake:     /webhooks/*               — routes/webhooks.ts (verified intake, never throttled)
 *   Gated app:  /app/*                    — routes/customer.ts (Clerk session + active org gate)
 *   Admin:      /admin/*                  — routes/admin.ts (service token + verified admin actor)
 *
 * Every route carries a rate-limit class (rateLimit(routeClass), gated by RATE_LIMIT_ENFORCED);
 * the class map lives in modules/ratelimit/routeClasses.ts and test/routeClassRegistry.test.ts
 * fails CI if any mounted route is neither classified nor exempt. Routes are registered as
 * register-functions on THIS app (never mounted express.Router()s): the registry test walks
 * app.router.stack and only sees layer.route, so a mounted Router would silently drop its
 * routes from that CI gate.
 *
 * Auth = Clerk (@clerk/express). Modelo A: Clerk carries auth identity ONLY — no regulated PII.
 */
import express, { type Request, type Response } from "express";
import { clerkMiddleware } from "@clerk/express";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerCustomerRoutes } from "./routes/customer.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { errorHandler } from "./http/errorHandler.js";
import { startServer } from "./server.js";

// Admin identity (PRD-08 §5.1). Enabling maker-checker WITHOUT verified identity is an
// unambiguous misconfig — four-eyes is defeatable then — so that hard-fails at boot. Running
// legacy body-trust (no secret) is allowed for dev/staging but emits a loud, greppable boot
// alarm so a real production that forgets ADMIN_CLERK_SECRET_KEY is never silent. (NODE_ENV
// can't distinguish dev-deployed from prod here — both are "production" — so the secret's
// presence IS the enforcement switch, not NODE_ENV.)
if (env.makerCheckerEnabled && !env.adminClerk.secretKey) {
  throw new Error("MAKER_CHECKER_ENABLED requires ADMIN_CLERK_SECRET_KEY (four-eyes needs verified admin identity)");
}
if (!env.adminClerk.secretKey) {
  console.warn(
    "security.admin_identity_unverified: /admin is running LEGACY body-trust — set ADMIN_CLERK_SECRET_KEY to enforce verified staff identity + RBAC (PRD-08 §5.1).",
  );
}

export const app = express();
app.disable("x-powered-by"); // don't advertise the framework (pentest 2026-07-13)
// Trust exactly N proxy hops (Cloudflare tunnel + Fly) so req.ip is the real client IP for
// rate limiting. Set via TRUST_PROXY_HOPS per environment; 0 in dev (no proxy). Never `true`.
app.set("trust proxy", env.rateLimit.trustProxyHops);
// Capture the raw body (needed to verify webhook signatures) while still parsing JSON.
// Limit lifted to env.rateLimit.webhookMaxBytes (default 1mb) so webhook payloads aren't
// truncated by express's 100kb default; other route bodies are tiny (flagged: global change).
app.use(express.json({
  limit: env.rateLimit.webhookMaxBytes,
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
}));
// Attach Clerk auth context to every request (does not enforce; routes opt in).
app.use(clerkMiddleware());

app.get("/healthz", async (_req: Request, res: Response) => {
  await pool.query("select 1");
  res.json({ ok: true });
});

// Registration ORDER is part of the contract: /webhooks/clerk must precede /webhooks/:provider,
// and each surface's parent gate (app.use) must precede its routes.
registerOnboardingRoutes(app);
registerWebhookRoutes(app);
registerCustomerRoutes(app);
registerAdminRoutes(app);

app.use(errorHandler);

// Guarded so importing `app` in tests binds no port and starts no scheduler.
if (process.env.NODE_ENV !== "test") startServer(app);
