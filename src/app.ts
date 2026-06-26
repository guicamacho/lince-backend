/**
 * Lince Phase 1 — HTTP entry (Express). Modular monolith.
 *
 *   Public:     GET  /healthz                 — liveness + DB ping
 *   Pre-active: POST /onboarding/prescreen     — completeness-only (Modelo A) -> pending org
 *   Intake:     POST /webhooks/:provider       — persist raw event ONLY (processing is gated/stubbed)
 *   Gated app:  everything under /app           — requires a Clerk session + an active org
 *
 * Auth = Clerk (@clerk/express). /app/* uses requireAuth() then maps the Clerk user
 * (getAuth.userId) -> people.clerk_user_id -> active org. Linking a Clerk user to a person
 * (signup/onboarding) is a later milestone. Modelo A: Clerk carries auth identity ONLY —
 * no regulated PII. Money flows (Avenia) + Didit are stubbed.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { env } from "./config/env.js";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { pool } from "./db/pool.js";
import { activeOrgForClerkUser } from "./modules/access/orgContext.js";
import { prescreenAndCreateOrg } from "./modules/onboarding/prescreen.js";
import { linkClerkUserFromEvent } from "./modules/identity/clerkSync.js";
import { Webhook } from "svix";

export const app = express();
// Capture the raw body (needed to verify webhook signatures) while still parsing JSON.
app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));
// Attach Clerk auth context to every request (does not enforce; routes opt in with requireAuth).
app.use(clerkMiddleware());

app.get("/healthz", async (_req: Request, res: Response) => {
  await pool.query("select 1");
  res.json({ ok: true });
});

// Onboarding pre-screen (pre-active surface). Completeness-only — Avenia decides admission.
app.post("/onboarding/prescreen", async (req: Request, res: Response) => {
  const result = await prescreenAndCreateOrg(req.body ?? {});
  res.status(201).json(result);
});

// Clerk webhook — SIGNATURE-VERIFIED (Svix). Registered before the generic /webhooks/:provider.
// This is the control that keeps the endpoint from being "open to everyone": no valid
// Svix signature -> rejected. (IP allowlisting, if ever wanted, belongs at the edge/Fly.)
app.post("/webhooks/clerk", async (req: Request, res: Response) => {
  const secret = env.clerk.webhookSigningSecret;
  if (!secret) {
    res.status(503).json({ error: "webhook_not_configured" });
    return;
  }
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
  let event: { type: string; data: unknown };
  try {
    event = new Webhook(secret).verify(raw, {
      "svix-id": req.header("svix-id") ?? "",
      "svix-timestamp": req.header("svix-timestamp") ?? "",
      "svix-signature": req.header("svix-signature") ?? "",
    }) as { type: string; data: unknown };
  } catch {
    res.status(400).json({ error: "invalid_signature" });
    return;
  }
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ('clerk', $1, $2, $3)
     on conflict (provider_code, external_event_id) do nothing`,
    [req.header("svix-id") ?? randomUUID(), event.type, JSON.stringify(event)],
  );
  await linkClerkUserFromEvent(event as Parameters<typeof linkClerkUserFromEvent>[0]);
  res.status(202).json({ received: true });
});

// Generic webhook intake — store the raw event; do NOT process (gated on vendor payload mapping).
app.post("/webhooks/:provider", async (req: Request, res: Response) => {
  const externalId = String(req.header("x-event-id") ?? req.body?.id ?? randomUUID());
  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
     values ($1, $2, $3, $4)
     on conflict (provider_code, external_event_id) do nothing`,
    [req.params.provider, externalId, String(req.body?.type ?? "unknown"), JSON.stringify(req.body ?? {})],
  );
  res.status(202).json({ received: true });
});

// The ONE access gate: a valid Clerk session AND an active org.
// clerkMiddleware populates auth; we return an API-style 401 (not requireAuth()'s redirect)
// when unauthenticated, and 403 when authenticated but mapped to no active org.
app.use("/app", async (req: Request, res: Response, next: NextFunction) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = await activeOrgForClerkUser(userId);
  if (!orgId) {
    res.status(403).json({ error: "no_active_org" });
    return;
  }
  res.locals.orgId = orgId;
  next();
});

app.get("/app/me", async (_req: Request, res: Response) => {
  const { rows } = await pool.query("select id, razao_social, state from orgs where id = $1", [res.locals.orgId]);
  res.json(rows[0] ?? null);
});

// Error handler — Express 5 forwards rejected async handlers here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    err instanceof Error && "statusCode" in err ? Number((err as { statusCode: unknown }).statusCode) || 500 : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : "internal_error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`lince-phase1 listening on :${port} — Avenia ${env.avenia.baseUrl}`));
