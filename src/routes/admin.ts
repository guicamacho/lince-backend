/**
 * Admin (internal) routes. Two gates for every /admin route: the service token (network guard)
 * and the admin ACTOR (PRD-08 §5.1): when ADMIN_CLERK_SECRET_KEY is set, the actor is bound to
 * a verified admin Clerk session and roles are enforced; else legacy body-trust. Write routes
 * add requireAdminRole(...) and use actingAdminId(res) instead of the body identity.
 */
import type { Express, Request, Response } from "express";
import { env } from "../config/env.js";
import { pool, withTransaction } from "../db/pool.js";
import { rateLimit } from "../modules/ratelimit/middleware.js";
import { requireAdminServiceToken } from "../modules/access/adminAuth.js";
import { requireAdminActor, requireAdminAccess, requireAdminRole, actingAdminId } from "../modules/access/adminActor.js";
import { mapVendorFees } from "../modules/money/moneyLoop.js";
import { replayFailedWebhook } from "../modules/webhooks/processor.js";
import { recordAveniaVerdict } from "../modules/onboarding/admission.service.js";
import { raiseRfi } from "../modules/onboarding/rfi.service.js";
import { setOrgAccess } from "../modules/access/access.service.js";
import { getOrgDetail } from "../modules/admin/orgDetail.js";
import { getAdmissionAging } from "../modules/admin/aging.js";
import { recordAuditExport } from "../modules/admin/auditExport.js";
import { listAdmins, setAdminRoles } from "../modules/admin/staff.js";
import { enqueueApproval, listOpenApprovals, decideApproval, type ApprovalActionType } from "../modules/admin/approvals.js";
import { createCase, listCases, getCaseDetail, assignCase, updateCaseStatus } from "../modules/cases/cases.service.js";
import { postAdminCaseMessage } from "../modules/cases/messages.service.js";

// Maker-checker (A4): the gated action types a SECOND operator must approve.
const APPROVAL_ACTION_TYPES = ["admission_relay", "org_block", "reversal", "role_grant"] as const;

export function registerAdminRoutes(app: Express): void {
  app.use("/admin", requireAdminServiceToken, requireAdminActor, requireAdminAccess);

  app.get("/admin/orgs", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `select id, cnpj, razao_social, state, admission_state, access_status, kyb_forwarded_at, created_at
         from orgs where deleted_at is null order by created_at desc limit 200`,
    );
    res.json({ orgs: rows });
  });

  // Unified all-orgs transactions view (PRD-04 §4.4): Avenia ticket lifecycle straight from the
  // stored quote; amounts in minor units (the admin app formats). Last 200; the grid filters
  // client-side like the orgs grid. ponytail: add query-param filters when 200 rows stop being
  // enough for ops.
  app.get("/admin/transactions", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `select t.id, t.org_id, o.razao_social, t.type, t.state, t.source_currency, t.source_amount,
              t.dest_currency, t.dest_amount, t.vendor_ref, t.created_at,
              t.quote->>'ticketStatus' as ticket_status, t.quote->'appliedFees' as applied_fees
         from org_transactions t join orgs o on o.id = t.org_id
        order by t.created_at desc limit 200`,
    );
    res.json({
      transactions: rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        razaoSocial: r.razao_social,
        type: r.type,
        state: r.state,
        ticketStatus: r.ticket_status ?? "UNPAID",
        sourceCurrency: r.source_currency,
        sourceAmount: r.source_amount === null ? null : Number(r.source_amount),
        destCurrency: r.dest_currency,
        destAmount: r.dest_amount === null ? null : Number(r.dest_amount),
        // shape-hardened: one malformed vendor fee snapshot must not 500 the all-orgs view
        fees: mapVendorFees(r.applied_fees),
        vendorRef: r.vendor_ref,
        createdAt: r.created_at,
      })),
    });
  });

  // Uploaded document references for an org (ops visibility; NO bytes exist to serve). Ops uses
  // these to know a customer provided EDD docs, then forwards to Avenia manually.
  app.get("/admin/orgs/:id/documents", rateLimit("admin_export"), async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `select d.id, d.filename, d.content_type, d.size_bytes, d.status, d.didit_ref, d.created_at, d.case_id
         from document_uploads d where d.org_id = $1 order by d.created_at desc limit 200`,
      [String(req.params.id)],
    );
    res.json({ documents: rows });
  });

  // Events & Webhooks health (PRD-04 §4.8): processing status across providers, plus
  // outbound notifications that failed or dead-lettered (Cluster 1 — undeliverable mail
  // is an ops-actionable failure, same as a dead webhook). The grid tabs client-side.
  app.get("/admin/webhooks", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    const [events, notifications] = await Promise.all([
      pool.query(
        `select id, provider_code, event_type, external_event_id, status, attempts, last_error,
                received_at, processed_at
           from webhook_events
          order by (status in ('failed','dead')) desc, received_at desc
          limit 200`,
      ),
      pool.query(
        `select id, event_type, template_id, recipient_ref, status, attempts, created_at, sent_at
           from notification_outbox
          where status in ('failed','dead')
          order by created_at desc
          limit 100`,
      ),
    ]);
    res.json({ events: events.rows, notifications: notifications.rows });
  });

  // Treasury recon (PRD-04 §13.3 / AC12): latest runs + non-resolved breaks. Read-only;
  // resolution flows through the linked recon_break case for now.
  app.get("/admin/recon", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    const [runs, breaks] = await Promise.all([
      pool.query(
        `select id, started_at, finished_at, status, summary from recon_runs order by started_at desc limit 20`,
      ),
      pool.query(
        `select b.id, b.run_id, b.subaccount_id, b.asset, b.break_type, b.expected_minor, b.actual_minor,
                b.status, b.detected_at, b.case_id, o.razao_social
           from recon_breaks b
           left join cases cs on cs.id = b.case_id
           left join orgs o on o.id = cs.org_id
          where b.status <> 'resolved'
          order by b.detected_at desc
          limit 100`,
      ),
    ]);
    res.json({ runs: runs.rows, breaks: breaks.rows });
  });

  // Replay a failed/dead event back through the drain (idempotent handlers make it safe).
  // Order matters: resolve the actor FIRST, then reset + audit in ONE transaction — a replay
  // re-fires a money-path handler and must never commit without its compliance trail.
  app.post("/admin/webhooks/:id/replay", rateLimit("admin_export"), requireAdminRole("treasury_ops", "support"), async (req: Request, res: Response) => {
    const eventId = String(req.params.id);
    const adminId = actingAdminId(res);
    const replayed = await withTransaction(async (c) => {
      if (!(await replayFailedWebhook(eventId, c))) return false;
      await c.query(
        `insert into audit_log (org_id, actor_type, actor_id, event, payload) values (null, 'ops', $1, 'admin.webhook_replayed', $2)`,
        [adminId, JSON.stringify({ eventId })],
      );
      return true;
    });
    if (!replayed) {
      res.status(409).json({ error: "not_replayable" });
      return;
    }
    res.json({ replayed: true });
  });

  // Record Avenia's decision (the relay gate). approved -> org active; rejected -> rejected +
  // CNPJ denylist (with the mandatory reason). Audit-logged AS A RELAY inside recordAveniaVerdict.
  // Modelo A: this records Avenia's verdict, not a Lince adjudication.
  app.post("/admin/orgs/:id/verdict", rateLimit("admin_export"), requireAdminRole("compliance"), async (req: Request, res: Response) => {
    const { decision, aveniaReference, remark } = req.body ?? {};
    if (decision !== "approved" && decision !== "rejected") {
      res.status(400).json({ error: "invalid_decision" });
      return;
    }
    if (decision === "rejected" && !String(remark ?? "").trim()) {
      res.status(400).json({ error: "remark_required_on_reject" });
      return;
    }
    const orgId = String(req.params.id);
    const adminId = actingAdminId(res);
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
  app.post("/admin/orgs/:id/rfi", rateLimit("admin_export"), requireAdminRole("compliance"), async (req: Request, res: Response) => {
    const { message } = req.body ?? {};
    if (!String(message ?? "").trim()) {
      res.status(400).json({ error: "message_required" });
      return;
    }
    res.json(await raiseRfi({ orgId: String(req.params.id), adminId: actingAdminId(res), message: String(message) }));
  });

  // Suspend / block / reinstate an org's access (the 0002 access_status seam). Lifecycle
  // `state` is untouched — this is an operational gate, not an admission decision. The
  // mandatory reason is enforced in setOrgAccess and audit-logged as org.access_changed.
  app.post("/admin/orgs/:id/access", rateLimit("admin_export"), requireAdminRole("compliance"), async (req: Request, res: Response) => {
    const { action, reason, source } = req.body ?? {};
    if (action !== "suspend" && action !== "block" && action !== "reinstate") {
      res.status(400).json({ error: "invalid_action" });
      return;
    }
    if (source !== undefined && source !== "lince_operational" && source !== "avenia_relay") {
      res.status(400).json({ error: "invalid_source" });
      return;
    }
    const orgId = String(req.params.id);
    const adminId = actingAdminId(res);
    await setOrgAccess({ orgId, action, reason: String(reason ?? ""), source, changedByAdminId: adminId });
    const { rows } = await pool.query(
      "select id, state, access_status, access_reason, access_changed_at from orgs where id = $1",
      [orgId],
    );
    res.json(rows[0] ?? null);
  });

  // Org 360 read (A2) — lifecycle + access + admission (with submitted-at/elapsed) + team +
  // last-50 audit. References + status only (Modelo A). Plain read; NOT audited.
  app.get("/admin/orgs/:id", rateLimit("admin_export"), async (req: Request, res: Response) => {
    res.json(await getOrgDetail(String(req.params.id)));
  });

  // Admission aging + latency (A3) — the pending queue (breach-flagged) + p50/p90/p95 latency.
  // Threshold is env.sla.admissionDays (wall-clock).
  app.get("/admin/admissions/aging", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    res.json(await getAdmissionAging(env.sla.admissionDays));
  });

  // Export-audit sink (A1) — records that an admin exported rows (the CSV is built client-side).
  app.post("/admin/audit/export", rateLimit("admin_export"), async (req: Request, res: Response) => {
    const { entity, filter, row_count } = req.body ?? {};
    const adminId = actingAdminId(res);
    await recordAuditExport({ adminId, entity: String(entity ?? ""), filter: filter ?? {}, rowCount: Number(row_count ?? 0) });
    res.json({ ok: true });
  });

  // --- Maker-checker (A4). Enqueue a gated action; a SECOND operator decides it. ---

  // Enqueue a gated action (requested_by = the acting admin). Executes on a peer's approval.
  app.post("/admin/approvals", rateLimit("admin_export"), requireAdminRole("compliance"), async (req: Request, res: Response) => {
    const { action_type, target_ref, payload } = req.body ?? {};
    if (!APPROVAL_ACTION_TYPES.includes(action_type)) {
      res.status(400).json({ error: "invalid_action_type" });
      return;
    }
    if (!String(target_ref ?? "").trim()) {
      res.status(400).json({ error: "target_ref_required" });
      return;
    }
    const adminId = actingAdminId(res);
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
  app.get("/admin/approvals", rateLimit("admin_export"), async (_req: Request, res: Response) => {
    res.json({ approvals: await listOpenApprovals() });
  });

  // Decide an open approval. CAS + maker-checker (403) + already-decided (409); on approve,
  // the executor runs in the same txn (org_block wired; others 501).
  app.post("/admin/approvals/:id/decide", rateLimit("admin_export"), requireAdminRole("compliance"), async (req: Request, res: Response) => {
    const { decision, remark } = req.body ?? {};
    if (decision !== "approved" && decision !== "declined") {
      res.status(400).json({ error: "invalid_decision" });
      return;
    }
    const adminId = actingAdminId(res);
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
  app.post("/admin/cases", rateLimit("admin_export"), requireAdminRole("compliance", "support"), async (req: Request, res: Response) => {
    const { org_id, type, priority, summary } = req.body ?? {};
    const adminId = actingAdminId(res);
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

  app.get("/admin/cases", rateLimit("admin_export"), async (req: Request, res: Response) => {
    res.json({
      cases: await listCases({
        type: req.query.type ? String(req.query.type) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        orgId: req.query.org_id ? String(req.query.org_id) : undefined,
      }),
    });
  });

  app.get("/admin/cases/:id", rateLimit("admin_export"), async (req: Request, res: Response) => {
    res.json(await getCaseDetail(String(req.params.id)));
  });

  app.post("/admin/cases/:id/messages", rateLimit("admin_export"), requireAdminRole("compliance", "support"), async (req: Request, res: Response) => {
    const { body, customer_visible } = req.body ?? {};
    const adminId = actingAdminId(res);
    res.status(201).json(
      await postAdminCaseMessage({
        caseId: String(req.params.id),
        authorAdminId: adminId,
        body: String(body ?? ""),
        customerVisible: customer_visible === true,
      }),
    );
  });

  app.post("/admin/cases/:id/status", rateLimit("admin_export"), requireAdminRole("compliance", "support"), async (req: Request, res: Response) => {
    const { status, resolution } = req.body ?? {};
    res.json(
      await updateCaseStatus({
        caseId: String(req.params.id),
        status: String(status ?? ""),
        resolution: resolution ? String(resolution) : undefined,
      }),
    );
  });

  app.post("/admin/cases/:id/assign", rateLimit("admin_export"), requireAdminRole("compliance", "support"), async (req: Request, res: Response) => {
    res.json(await assignCase(String(req.params.id), String(req.body?.assigned_admin_id ?? "")));
  });

  // --- Staff management (superadmin only) — the roster + role grants that make RBAC operable. ---
  app.get("/admin/admins", rateLimit("admin_export"), requireAdminRole(), async (_req: Request, res: Response) => {
    res.json({ admins: await listAdmins() });
  });

  app.post("/admin/admins/:id/roles", rateLimit("admin_export"), requireAdminRole(), async (req: Request, res: Response) => {
    const roles = Array.isArray(req.body?.roles) ? (req.body.roles as unknown[]).map(String) : [];
    res.json(await setAdminRoles(String(req.params.id), roles, actingAdminId(res)));
  });
}
