/**
 * Lince Phase 1 — HTTP entry (Express). Modular monolith.
 *
 *   Public:     GET  /healthz                       — liveness + DB ping
 *   Onboarding: POST /onboarding/bootstrap            — (authed) signup -> person + org(pending) + owner
 *               GET  /onboarding/state               — (authed) caller's org state (drives the shell gate)
 *               POST /onboarding/launch-verification  — (authed) pending -> kyb_in_progress (Didit launch, mocked)
 *               POST /onboarding/mock-verify          — (authed) kyb_in_progress -> vendor_pending (mock Didit complete)
 *               POST /onboarding/cnpj-lookup          — (authed) public Receita lookup (BrasilAPI) to pre-fill signup
 *   Intake:     POST /webhooks/clerk                 — Svix-verified; delegates to the webhook inbox module
 *               POST /webhooks/:provider             — verify (resend Svix) or store-only (avenia/didit); never throttled
 *   Gated app:  everything under /app                 — requires a Clerk session + an active org
 *                                                       POST /app/beneficiaries also step-up-gated (STEP_UP_ENFORCED)
 *                                                       and MFA-gated (MFA_POLICY, optional by default)
 *   Admin:      /admin/*                              — service-token gated; the admin app authenticates staff
 *                                                       via its own Clerk instance, then calls server-to-server.
 *                                                       approve = recordAveniaVerdict relay (Modelo A).
 *                                                       access = setOrgAccess (suspend/block/reinstate, audited).
 *
 * Every route carries a rate-limit class (rateLimit(routeClass), gated by RATE_LIMIT_ENFORCED);
 * the class map lives in modules/ratelimit/routeClasses.ts and test/routeClassRegistry.test.ts
 * fails CI if any mounted route is neither classified nor exempt. Webhooks are webhook_exempt
 * (providers retry, so they're never 429'd). A guarded scheduler drains the webhook + notification
 * outboxes in-process (skipped under NODE_ENV=test, alongside the guarded app.listen).
 *
 * Auth = Clerk (@clerk/express). Customer routes map the Clerk user (getAuth.userId)
 * -> people.clerk_user_id -> org. Modelo A: Clerk carries auth identity ONLY — no
 * regulated PII. Money flows (Avenia) + real Didit are stubbed.
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "./http/error.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { env } from "./config/env.js";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { pool } from "./db/pool.js";
import { activeMembershipForClerkUser } from "./modules/access/orgContext.js";
import { requirePermission, accessRoles } from "./modules/access/permissions.js";
import { listMembers, inviteMember, changeMemberRole, removeMember, transferOwnership, isDuplicateInvitation } from "./modules/team/team.service.js";
import { setOrgAccess } from "./modules/access/access.service.js";
import { bootstrapOrgForClerkUser } from "./modules/onboarding/bootstrap.js";
import { lookupCnpj } from "./modules/onboarding/cnpjLookup.js";
import { currentOrgForClerkUser, advanceCallerOrg } from "./modules/onboarding/onboardingState.js";
import { ensureAveniaSubaccount, depositDetailsForOrg } from "./modules/onboarding/aveniaProvisioning.js";
import { createDeposit, listTransactionsForOrg, reconcileInFlightDeposits } from "./modules/money/deposits.js";
import { balancesForOrg } from "./modules/ledger/ledger.service.js";
import { aveniaFromEnv } from "./modules/providers/avenia/avenia.client.js";
import { requireStepUp } from "./modules/access/requireStepUp.js";
import { requireMfaEnrolled } from "./modules/access/requireMfa.js";
import { rateLimit } from "./modules/ratelimit/middleware.js";
import { receiveWebhook } from "./modules/webhooks/inbox.js";
import { aveniaWebhookPublicKey } from "./modules/webhooks/aveniaKey.js";
import { drainWebhooks } from "./modules/webhooks/processor.js";
import { drainOutboxOnce } from "./modules/notifications/outbox.js";
import { recordAveniaVerdict } from "./modules/onboarding/admission.service.js";
import { listBeneficiariesForOrg, createBeneficiaryForOrg } from "./modules/beneficiaries/beneficiaries.service.js";
import { ensureAdminUser } from "./modules/identity/adminSync.js";
import { requireAdminServiceToken } from "./modules/access/adminAuth.js";
import { MockKybProvider } from "./modules/providers/didit/mock.kyb.js";
import { getOrgDetail } from "./modules/admin/orgDetail.js";
import { getAdmissionAging } from "./modules/admin/aging.js";
import { recordAuditExport } from "./modules/admin/auditExport.js";
import { enqueueApproval, listOpenApprovals, decideApproval, type ApprovalActionType } from "./modules/admin/approvals.js";
import { createCase, listCases, getCaseDetail, assignCase, updateCaseStatus } from "./modules/cases/cases.service.js";
import { postAdminCaseMessage } from "./modules/cases/messages.service.js";
import {
  listNotificationsForOrg,
  markNotificationRead,
  listCustomerCasesForOrg,
  getCaseThreadForOrg,
  getOpenRfiThreadForOrg,
  postCustomerCaseReply,
} from "./modules/cases/customerInbox.service.js";
import { raiseRfi } from "./modules/onboarding/rfi.service.js";

export const app = express();
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

// Per-provider inbound webhook secrets, resolved once from env for the verify registry.
// Avenia's is a published public key, fetched+cached from the API (RSA-PSS over raw body).
const webhookVerifierConfig = {
  clerkSecret: env.clerk.webhookSigningSecret,
  resendSecret: env.webhooks.resendSecret,
  aveniaPublicKey: aveniaWebhookPublicKey,
  diditSecret: env.didit.webhookSecret,
};

// Shared webhook route body: build the receipt input from the request and delegate to the
// inbox module (verify → persist → dedupe). The dedup id must come from a SIGNED source per
// provider, never an unsigned header an attacker can vary to bypass replay dedup:
//   clerk/resend -> svix-id (part of the Svix-signed set); avenia -> event.id (inside the
//   PSS-signed body). Unsigned x-event-id is only a last-resort for providers with no scheme.
async function handleWebhook(req: Request, res: Response, provider: string): Promise<void> {
  const body = (req.body ?? {}) as { id?: unknown; type?: unknown; eventId?: unknown; eventType?: unknown };
  // Avenia wraps everything: { event: { id, data: { type, ticket } } } (observed live 2026-07-07).
  const avenia = (req.body as { event?: { id?: unknown; data?: { type?: unknown } } } | null)?.event;
  // Signed sources first: svix-id (Svix-signed set), then body ids (inside an HMAC/PSS-signed
  // body). The unsigned x-event-id header is a last resort only — never let it shadow a signed id.
  const externalId = String(
    provider === "avenia"
      ? (avenia?.id ?? randomUUID())
      : (req.header("svix-id") ?? body.id ?? body.eventId ?? req.header("x-event-id") ?? randomUUID()),
  );
  const outcome = await receiveWebhook({
    provider,
    externalId,
    eventType: String(body.type ?? body.eventType ?? avenia?.data?.type ?? "unknown"),
    rawBody: (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "",
    payload: req.body ?? {},
    headers: {
      "svix-id": req.header("svix-id"),
      "svix-timestamp": req.header("svix-timestamp"),
      "svix-signature": req.header("svix-signature"),
      signature: req.header("signature"), // Avenia: base64 RSA-PSS over the raw body
      "x-signature": req.header("x-signature"), // Didit: hex HMAC-SHA256 over the raw body
    },
    config: webhookVerifierConfig,
    clientIp: req.ip,
  });
  res.status(outcome.status).json(outcome.body);
}

app.get("/healthz", async (_req: Request, res: Response) => {
  await pool.query("select 1");
  res.json({ ok: true });
});

// Bootstrap on signup (authed): person + org(pending) + owner. Captures CNPJ/name/role; NO CPF.
app.post("/onboarding/bootstrap", rateLimit("signup_start"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.status(201).json(await bootstrapOrgForClerkUser(uid, req.body ?? {}));
});

// Read the caller's org state (drives the customer shell gate). null if no org yet.
app.get("/onboarding/state", rateLimit("reads"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.json(await currentOrgForClerkUser(uid));
});

// "Start verification": Avenia COMPANY subaccount first (Connectivity §3 — KYB runs
// against it), then launch Didit (mocked) -> kyb_in_progress. ensure* is idempotent,
// so the RFI re-launch path reuses the existing subaccount.
app.post("/onboarding/launch-verification", rateLimit("signup_start"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  const current = await currentOrgForClerkUser(uid);
  if (!current) {
    res.status(404).json({ error: "no_org_for_user" });
    return;
  }
  await ensureAveniaSubaccount(current.orgId, aveniaFromEnv());
  const snap = await advanceCallerOrg(uid, "kyb_in_progress");
  const session = await mockKyb.launchVerification({ orgId: snap.orgId });
  res.json({ ...snap, hostedUrl: session.hostedUrl });
});

// Mock Didit complete + forward to Avenia -> vendor_pending (under review).
app.post("/onboarding/mock-verify", rateLimit("signup_start"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.json(await advanceCallerOrg(uid, "vendor_pending"));
});

// RFI (EDD) correspondence, readable/repliable during onboarding — the ONE case type that
// must reach a pre-active org. Caller org resolved from the Clerk user (any state); scoped
// to the open rfi_relay thread only (not the full inbox, which stays active-gated).
app.get("/onboarding/rfi", rateLimit("reads"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  const org = await currentOrgForClerkUser(uid);
  if (!org) {
    res.status(404).json({ error: "no_org_for_user" });
    return;
  }
  res.json(await getOpenRfiThreadForOrg(org.orgId));
});

app.post("/onboarding/rfi/reply", rateLimit("signup_start"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  const org = await currentOrgForClerkUser(uid);
  if (!org) {
    res.status(404).json({ error: "no_org_for_user" });
    return;
  }
  const thread = await getOpenRfiThreadForOrg(org.orgId);
  if (!thread.case) {
    res.status(404).json({ error: "no_open_rfi" });
    return;
  }
  res.status(201).json(
    await postCustomerCaseReply(org.orgId, uid, (thread.case as { id: string }).id, String(req.body?.body ?? "")),
  );
});

// Public Receita lookup (BrasilAPI) to pre-fill the signup form. Authed so it's not an
// open CNPJ proxy; rate-limited via the cnpj_lookup class (the in-memory guard was removed).
// Modelo A: public company data only, nothing persisted.
app.post("/onboarding/cnpj-lookup", rateLimit("cnpj_lookup"), async (req: Request, res: Response) => {
  const uid = requireClerkUserId(req, res);
  if (!uid) return;
  res.json(await lookupCnpj(uid, String(req.body?.cnpj ?? "")));
});

// Clerk webhook — SIGNATURE-VERIFIED (Svix). Registered before the generic /webhooks/:provider.
// This is the control that keeps the endpoint from being "open to everyone": no valid
// Svix signature -> rejected. Delegated to the webhook inbox module; the drain scheduler's
// clerkHandler links the user from the stored event (idempotent). Never throttled.
app.post("/webhooks/clerk", rateLimit("webhook_exempt"), async (req: Request, res: Response) => {
  await handleWebhook(req, res, "clerk");
});

// Generic webhook intake — resend is Svix-verified; avenia/didit are stored-only (scheme
// unconfirmed) until processing lands. Delegated to the same inbox module. Never throttled.
app.post("/webhooks/:provider", rateLimit("webhook_exempt"), async (req: Request, res: Response) => {
  await handleWebhook(req, res, String(req.params.provider));
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
  const membership = await activeMembershipForClerkUser(userId);
  if (!membership) {
    res.status(403).json({ error: "no_active_org" });
    return;
  }
  res.locals.orgId = membership.orgId;
  res.locals.personId = membership.personId;
  res.locals.roles = membership.roles; // raw; requirePermission filters to the access subset
  next();
});

app.get("/app/me", rateLimit("reads"), async (_req: Request, res: Response) => {
  const { rows } = await pool.query("select id, razao_social, state from orgs where id = $1", [res.locals.orgId]);
  // roles: access subset only — KYB tags never reach the UI (PRD-03 §5)
  res.json(rows[0] ? { ...rows[0], roles: accessRoles(res.locals.roles as string[]) } : null);
});

// Avenia deposit details (PIX + wallets) — post-approval only (the /app gate = the admin
// portal verdict). Avenia serves the data regardless of KYB status; pre-KYB the pixKey
// may be the shared master key (see aveniaProvisioning.depositDetailsForOrg note).
app.get("/app/deposit-details", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json(await depositDetailsForOrg(res.locals.orgId, aveniaFromEnv()));
});

// Create a PIX deposit: amount -> subaccount-scoped quote+ticket -> brCode the customer pays.
// Idempotent on (org, idemKey) with payload binding (PRD-07 §2 p5). First real money producer.
// Gated as money movement (PRD-03 §1): viewer is read-only, so creating a PIX charge maps to
// initiate_payout (deposit-create is the closest money atom; a dedicated one is over-modeling).
app.post("/app/deposits", rateLimit("beneficiary_write"), requirePermission("initiate_payout"), async (req: Request, res: Response) => {
  const { amountBrl, idemKey } = (req.body ?? {}) as { amountBrl?: string; idemKey?: string };
  if (!amountBrl || !idemKey) {
    res.status(422).json({ error: "amountBrl_and_idemKey_required" });
    return;
  }
  res.status(201).json(
    await createDeposit(res.locals.orgId, res.locals.personId ?? null, { amountBrl, idemKey }, aveniaFromEnv()),
  );
});

// Transaction list — the frozen contract the F3 Transações UI was built against.
app.get("/app/transactions", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json({ transactions: await listTransactionsForOrg(res.locals.orgId) });
});

// Ledger balances (minor units per currency) — settled money only, straight from postings.
app.get("/app/balances", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json({ balances: await balancesForOrg(res.locals.orgId) });
});

// Beneficiaries — travel-rule capture (AUSTRAC §4 / 255033346). The customer captures payee
// tracing info; Lince retains it and forwards to Avenia later (mocked in P1, so
// avenia_beneficiary_id stays null). The /app gate has set res.locals.orgId.
app.get("/app/beneficiaries", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json({ beneficiaries: await listBeneficiariesForOrg(res.locals.orgId) });
});

app.post(
  "/app/beneficiaries",
  rateLimit("beneficiary_write"),
  requirePermission("manage_beneficiaries"),
  requireStepUp(env.stepUp.enforced),
  // Payees are the money-out surface: an ENROLLED second factor is ALWAYS required here
  // (authoritative Clerk lookup, fail-closed; global MFA policy stays optional elsewhere).
  // The first payee is the enrollment trigger.
  requireMfaEnrolled(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    res.json(await createBeneficiaryForOrg(res.locals.orgId, userId, (req.body ?? {}) as Record<string, unknown>));
  },
);

// --- Team (PRD-03 F1/F3/F7). requirePermission is the WHO gate (owner/admin); the service
//     enforces WHAT is legal (owner protected, picker never offers owner, KYB tags inert). ---

/** Clerk invitation for a brand-new invitee; acceptance -> user.created webhook -> clerkSync
 *  links clerk_user_id + flips the membership invited->active. */
async function sendClerkInvitation(email: string): Promise<void> {
  const res = await fetch("https://api.clerk.com/v1/invitations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.clerk.secretKey ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email_address: email }),
  });
  if (res.ok) return;
  // A Clerk 4xx duplicate_record means an invitation for this email already exists and will be
  // delivered/accepted — treat as success so inviteMember doesn't compensate away the membership
  // the accepted invite later flips to active. Decision extracted + unit-tested (isDuplicateInvitation).
  const body = await res.json().catch(() => null);
  if (isDuplicateInvitation(res.status, body)) return;
  throw new Error(`clerk invitations.create ${res.status}`);
}

app.get("/app/team", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json({ members: await listMembers(res.locals.orgId) });
});

app.post("/app/team/invitations", rateLimit("beneficiary_write"), requirePermission("manage_team"), async (req: Request, res: Response) => {
  res.status(201).json(
    await inviteMember(res.locals.orgId, res.locals.personId, (req.body ?? {}) as Record<string, unknown>, sendClerkInvitation),
  );
});

app.post("/app/team/members/:personId/role", rateLimit("beneficiary_write"), requirePermission("manage_roles"), async (req: Request, res: Response) => {
  const role = String((req.body as { role?: unknown } | null)?.role ?? "");
  res.json({
    roles: await changeMemberRole(res.locals.orgId, res.locals.personId, String(req.params.personId), role),
  });
});

app.delete("/app/team/members/:personId", rateLimit("beneficiary_write"), requirePermission("manage_team"), async (req: Request, res: Response) => {
  await removeMember(res.locals.orgId, res.locals.personId, String(req.params.personId));
  res.json({ removed: true });
});

// Owner-only + step-up (PRD-03 F7: step-up + confirm; audit-logged in the service).
app.post(
  "/app/team/transfer-ownership",
  rateLimit("beneficiary_write"),
  requirePermission("transfer_ownership"),
  requireStepUp(env.stepUp.enforced),
  async (req: Request, res: Response) => {
    const to = String((req.body as { toPersonId?: unknown } | null)?.toPersonId ?? "");
    await transferOwnership(res.locals.orgId, res.locals.personId, to);
    res.json({ transferred: true });
  },
);

// --- Customer inbox ("Avisos") — behind the /app gate; org implicit via res.locals.orgId.
//     In-app only (D2, no email). L4 of the tipping-off model: every read is org-scoped and
//     returns only customer_visible messages on allowlisted-type cases. ---
app.get("/app/notifications", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json(await listNotificationsForOrg(res.locals.orgId));
});

app.post("/app/notifications/:id/read", rateLimit("reads"), async (req: Request, res: Response) => {
  res.json(await markNotificationRead(res.locals.orgId, String(req.params.id)));
});

app.get("/app/cases", rateLimit("reads"), async (_req: Request, res: Response) => {
  res.json({ cases: await listCustomerCasesForOrg(res.locals.orgId) });
});

app.get("/app/cases/:id/messages", rateLimit("reads"), async (req: Request, res: Response) => {
  res.json(await getCaseThreadForOrg(res.locals.orgId, String(req.params.id)));
});

// Reply-only (D1): customers reply to a staff-opened case, they do not open cases in v1.
app.post("/app/cases/:id/messages", rateLimit("beneficiary_write"), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  res.status(201).json(
    await postCustomerCaseReply(res.locals.orgId, userId, String(req.params.id), String(req.body?.body ?? "")),
  );
});

// --- Admin (internal) — service-token gated; the admin app authenticates staff via
//     its own (separate) Clerk instance, then calls these server-to-server. ---
app.get("/admin/orgs", rateLimit("admin_export"), requireAdminServiceToken, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `select id, cnpj, razao_social, state, admission_state, access_status, kyb_forwarded_at, created_at
       from orgs where deleted_at is null order by created_at desc limit 200`,
  );
  res.json({ orgs: rows });
});

// Record Avenia's decision (the relay gate). approved -> org active; rejected -> rejected +
// CNPJ denylist (with the mandatory reason). Audit-logged AS A RELAY inside recordAveniaVerdict.
// Modelo A: this records Avenia's verdict, not a Lince adjudication.
app.post("/admin/orgs/:id/verdict", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
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

// Relay an Avenia EDD info request to the customer (org -> rfi_required + customer-visible
// message). Modelo A: a relay, not a Lince request. Audit-logged inside raiseRfi.
app.post("/admin/orgs/:id/rfi", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, message } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  if (!String(message ?? "").trim()) {
    res.status(400).json({ error: "message_required" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  res.json(await raiseRfi({ orgId: String(req.params.id), adminId, message: String(message) }));
});

// Suspend / block / reinstate an org's access (the 0002 access_status seam). Lifecycle
// `state` is untouched — this is an operational gate, not an admission decision. The
// mandatory reason is enforced in setOrgAccess and audit-logged as org.access_changed.
app.post("/admin/orgs/:id/access", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, action, reason, source } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  if (action !== "suspend" && action !== "block" && action !== "reinstate") {
    res.status(400).json({ error: "invalid_action" });
    return;
  }
  if (source !== undefined && source !== "lince_operational" && source !== "avenia_relay") {
    res.status(400).json({ error: "invalid_source" });
    return;
  }
  const orgId = String(req.params.id);
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  await setOrgAccess({ orgId, action, reason: String(reason ?? ""), source, changedByAdminId: adminId });
  const { rows } = await pool.query(
    "select id, state, access_status, access_reason, access_changed_at from orgs where id = $1",
    [orgId],
  );
  res.json(rows[0] ?? null);
});

// Org 360 read (A2) — lifecycle + access + admission (with submitted-at/elapsed) + team +
// last-50 audit. References + status only (Modelo A). Plain read; NOT audited.
app.get("/admin/orgs/:id", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  res.json(await getOrgDetail(String(req.params.id)));
});

// Admission aging + latency (A3) — the pending queue (breach-flagged) + p50/p90/p95 latency.
// Threshold is env.sla.admissionDays (wall-clock).
app.get("/admin/admissions/aging", rateLimit("admin_export"), requireAdminServiceToken, async (_req: Request, res: Response) => {
  res.json(await getAdmissionAging(env.sla.admissionDays));
});

// Export-audit sink (A1) — records that an admin exported rows (the CSV is built client-side).
app.post("/admin/audit/export", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, entity, filter, row_count } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  await recordAuditExport({ adminId, entity: String(entity ?? ""), filter: filter ?? {}, rowCount: Number(row_count ?? 0) });
  res.json({ ok: true });
});

// --- Maker-checker (A4). Enqueue a gated action; a SECOND operator decides it. ---
const APPROVAL_ACTION_TYPES = ["admission_relay", "org_block", "reversal", "role_grant"] as const;

// Enqueue a gated action (requested_by = the acting admin). Executes on a peer's approval.
app.post("/admin/approvals", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, action_type, target_ref, payload } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  if (!APPROVAL_ACTION_TYPES.includes(action_type)) {
    res.status(400).json({ error: "invalid_action_type" });
    return;
  }
  if (!String(target_ref ?? "").trim()) {
    res.status(400).json({ error: "target_ref_required" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  res.status(201).json(
    await enqueueApproval({
      requestedByAdminId: adminId,
      actionType: action_type as ApprovalActionType,
      targetRef: String(target_ref),
      payload: (payload ?? {}) as Record<string, unknown>,
    }),
  );
});

// Open approvals queue (oldest first) — drives the admin badge + queue view.
app.get("/admin/approvals", rateLimit("admin_export"), requireAdminServiceToken, async (_req: Request, res: Response) => {
  res.json({ approvals: await listOpenApprovals() });
});

// Decide an open approval. CAS + maker-checker (403) + already-decided (409); on approve,
// the executor runs in the same txn (org_block wired; others 501).
app.post("/admin/approvals/:id/decide", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, decision, remark } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  if (decision !== "approved" && decision !== "declined") {
    res.status(400).json({ error: "invalid_decision" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  res.json(
    await decideApproval({
      id: String(req.params.id),
      decidedByAdminId: adminId,
      decision,
      remark: remark ? String(remark) : undefined,
    }),
  );
});

// --- Admin compliance cases — service-token gated. Operational taxonomy only (AML absent).
//     The customer-visibility wall lives in the service (messages.service messageCanBeCustomerVisible). ---
app.post("/admin/cases", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, org_id, type, priority, summary } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  res.status(201).json(
    await createCase({
      orgId: org_id ? String(org_id) : null,
      type: String(type ?? ""),
      priority: priority ? String(priority) : undefined,
      summary: summary ? String(summary) : undefined,
      openedByAdminId: adminId,
    }),
  );
});

app.get("/admin/cases", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  res.json({
    cases: await listCases({
      type: req.query.type ? String(req.query.type) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      orgId: req.query.org_id ? String(req.query.org_id) : undefined,
    }),
  });
});

app.get("/admin/cases/:id", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  res.json(await getCaseDetail(String(req.params.id)));
});

app.post("/admin/cases/:id/messages", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { adminClerkUserId, adminEmail, adminName, body, customer_visible } = req.body ?? {};
  if (!adminClerkUserId || !adminEmail) {
    res.status(400).json({ error: "missing_admin_identity" });
    return;
  }
  const adminId = await ensureAdminUser(String(adminClerkUserId), String(adminEmail), String(adminName ?? ""));
  res.status(201).json(
    await postAdminCaseMessage({
      caseId: String(req.params.id),
      authorAdminId: adminId,
      body: String(body ?? ""),
      customerVisible: customer_visible === true,
    }),
  );
});

app.post("/admin/cases/:id/status", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  const { status, resolution } = req.body ?? {};
  res.json(
    await updateCaseStatus({
      caseId: String(req.params.id),
      status: String(status ?? ""),
      resolution: resolution ? String(resolution) : undefined,
    }),
  );
});

app.post("/admin/cases/:id/assign", rateLimit("admin_export"), requireAdminServiceToken, async (req: Request, res: Response) => {
  res.json(await assignCase(String(req.params.id), String(req.body?.assigned_admin_id ?? "")));
});

// Error handler — Express 5 forwards rejected async handlers here.
// Contention timeouts (PRD-07 §7 "fail fast, RETRY SAFE"): pg 55P03 (lock_timeout) and
// 57014 (statement_timeout/cancel) become a retryable 503 with a neutral body — never a
// raw-message 500 a client would treat as fatal (verification-sweep finding, 2026-07-06).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const pgCode = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : null;
  if (pgCode === "55P03" || pgCode === "57014") {
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "temporarily_unavailable" });
    return;
  }
  // HttpError carries a curated, safe message (our own codes). ANY other error (pg, thrown
  // Error, syntax) is logged server-side and returned as a NEUTRAL body — never echo raw
  // messages (constraint/column names, "cannot convert to BigInt") to the client.
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  // Framework 4xx (body-parser's malformed-JSON 400 / oversized 413 are http-errors that also
  // carry statusCode): keep the status, neutralize the message — parser internals stay server-side.
  const fwStatus = err instanceof Error && "statusCode" in err ? Number((err as { statusCode: unknown }).statusCode) : NaN;
  if (fwStatus >= 400 && fwStatus < 500) {
    res.status(fwStatus).json({ error: "bad_request" });
    return;
  }
  console.warn("unhandled_error", JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  res.status(500).json({ error: "internal_error" });
});

// Entry side-effects. Guarded so importing `app` in tests (routeClassRegistry walks the
// router) neither binds a port nor starts the drain. NODE_ENV=test is set in the test script.
// ponytail: guarded listen over an app/server split; extract src/server.ts only if a second
// real entry point appears.
const DRAIN_INTERVAL_MS = Number(process.env.DRAIN_INTERVAL_MS ?? 5000);
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`lince-phase1 listening on :${port} — Avenia ${env.avenia.baseUrl}`));
  // Single in-process scheduler drains both outboxes. Both claims use FOR UPDATE SKIP LOCKED,
  // so a second machine is safe (wasteful, not wrong). One tick failing is logged, not fatal.
  const notifyConfig = {
    emailAdapter: env.notify.emailAdapter,
    resendApiKey: env.notify.resendApiKey,
    from: env.notify.from,
    replyTo: env.notify.replyTo,
    slackWebhookUrl: env.notify.slackWebhookUrl,
  };
  // Single-flight: skip a tick if the previous one is still running, so a slow DB can't
  // pile up overlapping drains and exhaust the connection pool.
  let draining = false;
  let tick = 0;
  setInterval(() => {
    if (draining) return;
    draining = true;
    tick++;
    void (async () => {
      try {
        await drainWebhooks();
        await drainOutboxOnce(notifyConfig);
        // Deposit reconcile backstop every ~12th tick (~60s at the 5s drain cadence):
        // webhooks win when flowing; this catches missed deliveries — and is the ONLY
        // settle path in local dev, where webhooks point at the deployed endpoint.
        const avenia = aveniaFromEnv();
        if (avenia && tick % 12 === 0) await reconcileInFlightDeposits(avenia);
      } catch (err) {
        console.warn("drain.tick_failed", err instanceof Error ? err.message : String(err));
      } finally {
        draining = false;
      }
    })();
  }, DRAIN_INTERVAL_MS);
}
