/**
 * The gated customer app: everything under /app. The parent gate is THE access control —
 * a valid Clerk session AND an active org — and it sets res.locals.{orgId,personId,roles}
 * for every route below. Money-out routes stack rateLimit + requirePermission + requireStepUp
 * + requireMfaEnrolled (PRD-07).
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { rateLimit } from "../modules/ratelimit/middleware.js";
import { activeMembershipForClerkUser } from "../modules/access/orgContext.js";
import { requirePermission, accessRoles } from "../modules/access/permissions.js";
import { requireStepUp } from "../modules/access/requireStepUp.js";
import { requireMfaEnrolled } from "../modules/access/requireMfa.js";
import { ensureClerkUserLinked } from "../modules/identity/clerkSync.js";
import { depositDetailsForOrg } from "../modules/onboarding/aveniaProvisioning.js";
import { createDeposit } from "../modules/money/deposits.js";
import { createConvert } from "../modules/money/convert.js";
import { createPayout } from "../modules/money/payout.js";
import { listTransactionsForOrg } from "../modules/money/moneyLoop.js";
import { balancesForOrg, balanceHistoryForOrg } from "../modules/ledger/ledger.service.js";
import { getRates, type RateQuoteFn } from "../modules/money/rates.service.js";
import { aveniaFromEnv } from "../modules/providers/avenia/avenia.client.js";
import { listBeneficiariesForOrg, createBeneficiaryForOrg } from "../modules/beneficiaries/beneficiaries.service.js";
import { listMembers, inviteMember, resendInvitation, changeMemberRole, removeMember, transferOwnership } from "../modules/team/team.service.js";
import { sendFreshInvitation, revokeInvitationsFor } from "../modules/team/clerkInvitations.js";
import { submitDocument, listDocumentsForCase, MAX_DOC_BYTES } from "../modules/documents/documents.service.js";
import { MockDiditDocuments, DiditDocuments } from "../modules/providers/didit/documents.js";
import {
  listNotificationsForOrg,
  markNotificationRead,
  listCustomerCasesForOrg,
  getCaseThreadForOrg,
  postCustomerCaseReply,
} from "../modules/cases/customerInbox.service.js";

export function registerCustomerRoutes(app: Express): void {
  // Document submission is MOCKED until Didit's real doc API is confirmed (env flip when it
  // lands). Either way Lince stores only a reference, never the bytes.
  const diditDocuments = env.didit.documentsLive ? new DiditDocuments() : new MockDiditDocuments();

  // The ONE access gate: a valid Clerk session AND an active org.
  // clerkMiddleware populates auth; we return an API-style 401 (not requireAuth()'s redirect)
  // when unauthenticated, and 403 when authenticated but mapped to no active org.
  app.use("/app", async (req: Request, res: Response, next: NextFunction) => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    let membership = await activeMembershipForClerkUser(userId);
    if (!membership) {
      // Invited-signup fallback (see /onboarding/state): link-on-login, then retry once.
      await ensureClerkUserLinked(userId);
      membership = await activeMembershipForClerkUser(userId);
    }
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

  // Convert (PRD-10): standalone currency swap of the customer's own balance (BRL<->USD via
  // BRLA<->USDT). Money movement — 'ticket' rate class, initiate_payout permission, step-up +
  // MFA claim. Two-phase reservation under the org money lock lives in createConvert.
  app.post(
    "/app/convert",
    rateLimit("ticket"),
    requirePermission("initiate_payout"),
    requireStepUp(env.stepUp.enforced),
    requireMfaEnrolled(),
    async (req: Request, res: Response) => {
      const { from, to, amount, idemKey } = (req.body ?? {}) as {
        from?: string; to?: string; amount?: string; idemKey?: string;
      };
      if (!from || !to || !amount || !idemKey) {
        res.status(422).json({ error: "from_to_amount_idemKey_required" });
        return;
      }
      res.status(201).json(
        await createConvert(res.locals.orgId, res.locals.personId ?? null, { from, to, amount, idemKey }, aveniaFromEnv()),
      );
    },
  );

  // Payouts (PRD-11): money-out of held balance to a registered payee over the payee's rail
  // (PIX from BRLA; USD ACH/WIRE and crypto from stablecoins). Same money-movement gates as
  // Convert plus the payout-only ones inside createPayout (beneficiary org/rail/status checks,
  // 24h post-recovery hold). Two-phase reservation under the org money lock lives in createPayout.
  app.post(
    "/app/payouts",
    rateLimit("ticket"),
    requirePermission("initiate_payout"),
    requireStepUp(env.stepUp.enforced),
    requireMfaEnrolled(),
    async (req: Request, res: Response) => {
      const { beneficiaryId, amount, idemKey } = (req.body ?? {}) as {
        beneficiaryId?: string; amount?: string; idemKey?: string;
      };
      if (!beneficiaryId || !amount || !idemKey) {
        res.status(422).json({ error: "beneficiaryId_amount_idemKey_required" });
        return;
      }
      res.status(201).json(
        await createPayout(res.locals.orgId, res.locals.personId ?? null, { beneficiaryId, amount, idemKey }, aveniaFromEnv()),
      );
    },
  );

  // Transaction list — the frozen contract the F3 Transações UI was built against.
  app.get("/app/transactions", rateLimit("reads"), async (_req: Request, res: Response) => {
    res.json({ transactions: await listTransactionsForOrg(res.locals.orgId) });
  });

  // Ledger balances (minor units per currency) — settled money only, straight from postings.
  app.get("/app/balances", rateLimit("reads"), async (_req: Request, res: Response) => {
    res.json({ balances: await balancesForOrg(res.locals.orgId) });
  });

  // Daily settled-balance history (Início chart) — cumulative per-currency, SP days, gaps filled.
  app.get("/app/balance-history", rateLimit("reads"), async (_req: Request, res: Response) => {
    res.json({ history: await balanceHistoryForOrg(res.locals.orgId) });
  });

  // Display FX rates for the Câmbio board (BRL-USD both ways via BRLA<>USDT; BRL-EUR one way),
  // bare + mid-market-checked, ~30s cached. A GET quote — not the gated execution path. Degrades
  // to mid-market (or nulls) if Avenia's rate quote is unavailable.
  app.get("/app/rates", rateLimit("reads"), async (_req: Request, res: Response) => {
    const { rows } = await pool.query<{ subaccount_id: string | null }>(
      "select subaccount_id from avenia_accounts where org_id = $1",
      [res.locals.orgId],
    );
    const sub = rows[0]?.subaccount_id ?? null;
    const client = aveniaFromEnv();
    const quote: RateQuoteFn =
      sub && client
        ? (i) => client.quoteRate({ subAccountId: sub, inputCurrency: i.inputCurrency, outputCurrency: i.outputCurrency })
        : async () => null;
    res.json(await getRates(sub ?? "none", quote));
  });

  // Beneficiaries — travel-rule capture (AUSTRAC §4 / 255033346). The customer captures payee
  // tracing info; Lince retains it and lazily forwards to Avenia on first payout.
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

  app.get("/app/team", rateLimit("reads"), async (_req: Request, res: Response) => {
    res.json({ members: await listMembers(res.locals.orgId) });
  });

  app.post("/app/team/invitations", rateLimit("beneficiary_write"), requirePermission("manage_team"), async (req: Request, res: Response) => {
    res.status(201).json(
      await inviteMember(res.locals.orgId, res.locals.personId, (req.body ?? {}) as Record<string, unknown>, sendFreshInvitation),
    );
  });

  // Resend the invite email to a pending member (cooldown-guarded in the service).
  app.post("/app/team/members/:personId/resend", rateLimit("beneficiary_write"), requirePermission("manage_team"), async (req: Request, res: Response) => {
    await resendInvitation(res.locals.orgId, res.locals.personId, String(req.params.personId), sendFreshInvitation);
    res.json({ resent: true });
  });

  app.post("/app/team/members/:personId/role", rateLimit("beneficiary_write"), requirePermission("manage_roles"), async (req: Request, res: Response) => {
    const role = String((req.body as { role?: unknown } | null)?.role ?? "");
    res.json({
      roles: await changeMemberRole(res.locals.orgId, res.locals.personId, String(req.params.personId), role),
    });
  });

  app.delete("/app/team/members/:personId", rateLimit("beneficiary_write"), requirePermission("manage_team"), async (req: Request, res: Response) => {
    await removeMember(res.locals.orgId, res.locals.personId, String(req.params.personId), revokeInvitationsFor);
    res.json({ removed: true });
  });

  // Owner-only + step-up (PRD-03 F7: step-up + confirm; audit-logged in the service).
  app.post(
    "/app/team/transfer-ownership",
    rateLimit("beneficiary_write"),
    requirePermission("transfer_ownership"),
    requireStepUp(env.stepUp.enforced),
    requireMfaEnrolled(), // always-on 2FA claim, like beneficiaries (pentest 2026-07-13)
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
  // respond_cases excludes the read-only viewer (pentest 2026-07-13).
  app.post("/app/cases/:id/messages", rateLimit("beneficiary_write"), requirePermission("respond_cases"), async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    res.status(201).json(
      await postCustomerCaseReply(res.locals.orgId, userId, String(req.params.id), String(req.body?.body ?? "")),
    );
  });

  // Document upload (EDD/RFI). No-retention: the raw bytes stream to Didit (mock) and only a
  // reference is stored — the file is never persisted. octet-stream body (the BFF forwards it);
  // express.raw parses just this route (global express.json skips non-json content-types). Filename
  // + content-type ride in headers. ponytail: 15mb in-memory buffer is fine for a mock scaffold;
  // switch to a streamed multipart parser if real Didit needs large files without buffering.
  app.get("/app/cases/:id/documents", rateLimit("reads"), async (req: Request, res: Response) => {
    // ORG-SCOPED: pass res.locals.orgId so a caller can only read their own org's case documents.
    res.json({ documents: await listDocumentsForCase(res.locals.orgId, String(req.params.id)) });
  });

  app.post(
    "/app/cases/:id/documents",
    rateLimit("beneficiary_write"),
    requirePermission("respond_cases"), // not the read-only viewer (pentest 2026-07-13)
    express.raw({ type: "application/octet-stream", limit: MAX_DOC_BYTES }),
    async (req: Request, res: Response) => {
      const doc = await submitDocument(
        {
          orgId: res.locals.orgId,
          caseId: String(req.params.id),
          uploadedByPersonId: res.locals.personId ?? null,
          filename: decodeURIComponent(req.header("x-filename") ?? "documento"),
          contentType: req.header("x-content-type") ?? "application/octet-stream",
          content: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        },
        diditDocuments,
      );
      res.status(201).json(doc);
    },
  );
}
