/**
 * Onboarding routes (pre-active org): signup bootstrap, state read, KYB launch (mocked),
 * RFI correspondence, CNPJ lookup. These need a Clerk session but NOT an active org — that
 * is the /app gate's job (routes/customer.ts).
 */
import type { Express, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { env } from "../config/env.js";
import { rateLimit } from "../modules/ratelimit/middleware.js";
import { bootstrapOrgForClerkUser } from "../modules/onboarding/bootstrap.js";
import { lookupCnpj } from "../modules/onboarding/cnpjLookup.js";
import { currentOrgForClerkUser, advanceCallerOrg } from "../modules/onboarding/onboardingState.js";
import { ensureAveniaSubaccount } from "../modules/onboarding/aveniaProvisioning.js";
import { ensureClerkUserLinked } from "../modules/identity/clerkSync.js";
import { aveniaFromEnv } from "../modules/providers/avenia/avenia.client.js";
import { MockKybProvider } from "../modules/providers/didit/mock.kyb.js";
import { getOpenRfiThreadForOrg, postCustomerCaseReply } from "../modules/cases/customerInbox.service.js";

// Resolve the caller's Clerk user id, or write a 401 and return null. Single-consumer helper:
// every onboarding route needs a session; the /app and /admin surfaces have their own gates.
export function requireClerkUserId(req: Request, res: Response): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return userId;
}

// The mock KYB endpoints (launch + self-complete) exist ONLY while Didit is mocked, which we
// tie to the Avenia SANDBOX base URL: any environment on production keys (staging/prod) is not
// sandbox, so these 404 there — no user can fabricate a "KYB done" signal, and there is no flag
// to forget (pentest 2026-07-13, HIGH). Real Didit hosted capture replaces both at cutover.
const MOCK_KYB = env.avenia.baseUrl.includes("sandbox");

export function registerOnboardingRoutes(app: Express): void {
  const mockKyb = new MockKybProvider();

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
    let org = await currentOrgForClerkUser(uid);
    if (!org) {
      // Invited-signup fallback: the user.created webhook may lag (or never reach a local
      // backend) — link by verified email now so an invitee lands in their org, not onboarding.
      await ensureClerkUserLinked(uid);
      org = await currentOrgForClerkUser(uid);
    }
    res.json(org);
  });

  // "Start verification": Avenia COMPANY subaccount first (Connectivity §3 — KYB runs
  // against it), then launch Didit (mocked) -> kyb_in_progress. ensure* is idempotent,
  // so the RFI re-launch path reuses the existing subaccount.
  app.post("/onboarding/launch-verification", rateLimit("signup_start"), async (req: Request, res: Response) => {
    if (!MOCK_KYB) { res.status(404).json({ error: "not_found" }); return; }
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

  // Mock Didit complete + forward to Avenia -> vendor_pending (under review). Sandbox-only (MOCK_KYB).
  app.post("/onboarding/mock-verify", rateLimit("signup_start"), async (req: Request, res: Response) => {
    if (!MOCK_KYB) { res.status(404).json({ error: "not_found" }); return; }
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
}
