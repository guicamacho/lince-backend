/**
 * Lince Phase 1 — HTTP entry (Express). Modular monolith.
 *
 *   Public:     GET  /healthz                       — liveness + DB ping
 *   Onboarding: POST /onboarding/bootstrap            — (authed) signup -> person + org(pending) + owner
 *               GET  /onboarding/state               — (authed) caller's org state (drives the shell gate)
 *               POST /onboarding/launch-verification  — (authed) pending -> kyb_in_progress (Didit launch, mocked)
 *               POST /onboarding/mock-verify          — (authed) kyb_in_progress -> vendor_pending (mock Didit complete)
 *   Intake:     POST /webhooks/:provider             — persist raw event ONLY (processing is gated/stubbed)
 *   Gated app:  everything under /app                 — requires a Clerk session + an active org
 *   Admin:      /admin/*                              — service-token gated; the admin app authenticates staff
 *                                                       via its own Clerk instance, then calls server-to-server.
 *                                                       approve = recordAveniaVerdict relay (Modelo A).
 *
 * Auth = Clerk (@clerk/express). Customer routes map the Clerk user (getAuth.userId)
 * -> people.clerk_user_id -> org. Modelo A: Clerk carries auth identity ONLY — no
 * regulated PII. Money flows (Avenia) + real Didit are stubbed.
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
import { bootstrapOrgForClerkUser } from "./modules/onboarding/bootstrap.js";
import { currentOrgForClerkUser, advanceCallerOrg } from "./modules/onboarding/onboardingState.js";
import { recordAveniaVerdict } from "./modules/onboarding/admission.service.js";
import { ensureAdminUser } from "./modules/identity/adminSync.js";
import { requireAdminServiceToken } from "./modules/access/adminAuth.js";
import { MockKybProvider } from "./modules/providers/didit/mock.kyb.js";

export const app = express();
// Capture the raw body (needed to verify webhook signatures) while still parsing JSON.
app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));
// Attach Clerk auth context to every request (does not enforce; routes opt in).
app.use(clerkMiddleware());

const mockKyb = new MockKybProvider();

// Resolve the caller's Clerk user id, or write a 401 and return null. Pre-active
// onboarding routes need a session but NOT an active org (that's the /app gate).
function requireClerkUserId(req: Request, res: Response): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return userId;
}

app.get("/healthz", async (_req: Request, res: Response) => {
  await pool.query("select 1");
  res.json({ ok: true });
});

// Onboarding pre-screen (pre-active surface). Completeness-only — Avenia decides admission.
app.post("/onboarding/prescreen", async (req: Request, res: Response) => {
  const result = await prescreenAndCreateOrg(req.body ?? {});
  res.status(201).json(result);
});

// Bootstrap on signup (authed): person + org(pending) + owner. Captures CNPJ/name/role; NO CPF.
app.post("/onboarding/bootstrap", async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.status(201).json(await bootstrapOrgForClerkUser(uid, req.body ?? {}));
});

// Read the caller's org state (drives the customer shell gate). null if no org yet.
app.get("/onboarding/state", async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.json(await currentOrgForClerkUser(uid));
});

// "Start verification": launch Didit (mocked) -> kyb_in_progress.
app.post("/onboarding/launch-verification", async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  const snap = await advanceCallerOrg(uid, "kyb_in_progress");
  const session = await mockKyb.launchVerification({ orgId: snap.orgId });
  res.json({ ...snap, hostedUrl: session.hostedUrl });
});

// Mock Didit complete + forward to Avenia -> vendor_pending (under review).
app.post("/onboarding/mock-verify", async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.json(await advanceCallerOrg(uid, "vendor_pending"));
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

// --- Admin (internal) — service-token gated; the admin app authenticates staff via
//     its own (separate) Clerk instance, then calls these server-to-server. ---
app.get("/admin/orgs", requireAdminServiceToken, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `select id, cnpj, razao_social, state, admission_state, access_status, kyb_forwarded_at, created_at
       from orgs where deleted_at is null order by created_at desc limit 200`,
  );
  res.json({ orgs: rows });
});

// Record Avenia's decision (the relay gate). approved -> org active; rejected -> rejected +
// CNPJ denylist (with the mandatory reason). Audit-logged AS A RELAY inside recordAveniaVerdict.
// Modelo A: this records Avenia's verdict, not a Lince adjudication.
app.post("/admin/orgs/:id/verdict", requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, decision, aveniaReference, remark } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "invalid_decision" });
    return;
  }
  if (decision === "rejected" && !String(remark ?? "").trim()) {
    res.status(400).json({ error: "remark_required_on_reject" });
    return;
  }
  const orgId = String(req.params.id);
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  await recordAveniaVerdict({
    orgId,
    decision,
    aveniaReference: String(aveniaReference || `stub-skeleton-${Date.now()}`),
    recordedByAdminId: adminId,
    remark: remark ? String(remark) : undefined,
  });
  const { rows } = await pool.query("select id, state, admission_state from orgs where id = $1", [orgId]);
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
