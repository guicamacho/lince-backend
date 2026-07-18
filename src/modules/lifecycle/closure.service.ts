/**
 * Lifecycle completion (Completion Register, Cluster 3).
 *
 * closeOrgForOwner — voluntary closure (PRD-01 §13.1, PRD-07 Pattern 13): under the
 * per-org MONEY lock so a concurrent payout/convert can't race the zero-balance check,
 * verify every customer-liability balance is zero AND nothing is in flight, then
 * state -> 'closed' + closed_at (the 7-year retention anchor). The org row is never
 * deleted (PRD-03 never-delete); the /app gate (state='active') closes the app by itself.
 *
 * runLifecycleSweep — the scheduled jobs (server.ts hourly tick):
 *   - stale applications (PRD-01 §10.5): customer-action states only
 *     (pending_lince_approval / kyb_in_progress / rfi_required — vendor_pending is
 *     Avenia's queue and never expires): warning at 60d, final warning at 80d,
 *     soft-delete + notice at 90d. Warning emails dedupe on the outbox row itself.
 *   - dormancy outreach: active orgs with no transactions for DORMANCY_DAYS get the
 *     neutral PRD-14 §5D note, at most once per 90 days.
 *   - retention soft-delete: declined/rejected orgs older than RETENTION_DAYS get
 *     deleted_at (the CNPJ denylist keeps rejects blocked). NO email — the never-send
 *     list forbids proactive contact with a rejected org.
 *   - rate_limits cleanup (PRD-07): drop fixed windows older than a day.
 */
import { withTransaction, pool } from "../../db/pool.js";
import { acquireOrgMoneyLock } from "../../db/lockKeys.js";
import { HttpError } from "../../http/error.js";
import { assertTransition, type OrgState } from "../identity/org.state.js";
import { enqueueNotification } from "../notifications/outbox.js";

/** PRD-01 §10.5 — explicit day marks for stale applications. */
const STALE_WARN_1 = 60;
const STALE_WARN_2 = 80;
const STALE_EXPIRE = 90;
/** ponytail: constants, not env — flip to env only when product wants to tune them. */
const DORMANCY_DAYS = 180;
const DORMANCY_REPEAT_DAYS = 90;
const RETENTION_SOFTDELETE_DAYS = 90;

const STALE_STATES = `('pending_lince_approval','kyb_in_progress','rfi_required')`;

export async function closeOrgForOwner(orgId: string, personId: string | null): Promise<{ closedAt: string }> {
  return withTransaction(async (c) => {
    await acquireOrgMoneyLock(c, orgId); // Pattern 13: no money movement can race this check
    const { rows } = await c.query<{ state: OrgState; razao_social: string }>(
      `select state, razao_social from orgs where id = $1 and deleted_at is null for update`,
      [orgId],
    );
    if (!rows[0]) throw new HttpError("org_not_found", 404);
    try {
      assertTransition(rows[0].state, "closed");
    } catch {
      throw new HttpError("org_not_active", 409);
    }

    const inFlight = await c.query(
      `select 1 from org_transactions
        where org_id = $1 and state in ('created','funding','executing','on_hold') limit 1`,
      [orgId],
    );
    if (inFlight.rowCount) throw new HttpError("transactions_in_flight", 422);

    const nonZero = await c.query(
      `select 1 from ledger_accounts a
        where a.org_id = $1 and a.type = 'customer_liability'
          and (select coalesce(sum(p.amount), 0) from ledger_postings p where p.account_id = a.id) <> 0
        limit 1`,
      [orgId],
    );
    if (nonZero.rowCount) throw new HttpError("balance_not_zero", 422);

    const upd = await c.query<{ closed_at: string }>(
      `update orgs set state = 'closed', closed_at = now(), updated_at = now()
        where id = $1 returning closed_at`,
      [orgId],
    );
    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, $2, $3, 'org.closed', $4)`,
      [orgId, personId ? "user" : "system", personId, JSON.stringify({ voluntary: true })],
    );
    await enqueueNotification(c, {
      eventType: "closure_completed",
      recipientRef: orgId,
      templateId: "closure_completed",
      payload: { razaoSocial: rows[0].razao_social },
    });
    return { closedAt: upd.rows[0]!.closed_at };
  });
}

/** One pass of every lifecycle job. Returns counts (logged by the scheduler, asserted in tests). */
export async function runLifecycleSweep(): Promise<{
  warned60: number;
  warned80: number;
  expired: number;
  dormancyPinged: number;
  retentionDeleted: number;
  rateWindowsDropped: number;
}> {
  // 60d warning — only while the org has NOT yet crossed the 80d mark (else the final
  // warning below is the one that fires; never both in the same sweep).
  const warned60 = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select id from orgs
        where state in ${STALE_STATES} and deleted_at is null
          and updated_at < now() - interval '${STALE_WARN_1} days'
          and updated_at >= now() - interval '${STALE_WARN_2} days'
          and not exists (select 1 from notification_outbox n
                           where n.event_type = 'stale_warning_60d' and n.recipient_ref = orgs.id::text)`,
    );
    for (const r of rows) {
      await enqueueNotification(c, { eventType: "stale_warning_60d", recipientRef: r.id, templateId: "stale_warning_60d" });
    }
    return rows.length;
  });

  const warned80 = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string; days_left: number }>(
      `select id, greatest(1, ${STALE_EXPIRE} - floor(extract(epoch from (now() - updated_at)) / 86400))::int as days_left
         from orgs
        where state in ${STALE_STATES} and deleted_at is null
          and updated_at < now() - interval '${STALE_WARN_2} days'
          and updated_at >= now() - interval '${STALE_EXPIRE} days'
          and not exists (select 1 from notification_outbox n
                           where n.event_type = 'stale_warning_80d' and n.recipient_ref = orgs.id::text)`,
    );
    for (const r of rows) {
      await enqueueNotification(c, {
        eventType: "stale_warning_80d",
        recipientRef: r.id,
        templateId: "stale_warning_80d",
        payload: { daysLeft: r.days_left },
      });
    }
    return rows.length;
  });

  // Expiry: soft-delete (the org vanishes from every deleted_at-is-null query, so the
  // person can simply start a fresh application later — matching the notice copy).
  // Email resolution survives the soft delete: it joins org_people/people only.
  const expired = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `update orgs set deleted_at = now(), updated_at = now()
        where state in ${STALE_STATES} and deleted_at is null
          and updated_at < now() - interval '${STALE_EXPIRE} days'
        returning id`,
    );
    for (const r of rows) {
      await c.query(
        `insert into audit_log (org_id, actor_type, actor_id, event, payload)
         values ($1, 'system', null, 'application.expired', $2)`,
        [r.id, JSON.stringify({ afterDays: STALE_EXPIRE })],
      );
      await enqueueNotification(c, { eventType: "application_expired", recipientRef: r.id, templateId: "application_expired" });
    }
    return rows.length;
  });

  const dormancyPinged = await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select o.id from orgs o
        where o.state = 'active' and o.access_status = 'active' and o.deleted_at is null
          and coalesce(o.activated_at, o.created_at) < now() - interval '${DORMANCY_DAYS} days'
          and not exists (select 1 from org_transactions t
                           where t.org_id = o.id and t.created_at > now() - interval '${DORMANCY_DAYS} days')
          and not exists (select 1 from notification_outbox n
                           where n.event_type = 'dormancy_outreach' and n.recipient_ref = o.id::text
                             and n.created_at > now() - interval '${DORMANCY_REPEAT_DAYS} days')`,
    );
    for (const r of rows) {
      await enqueueNotification(c, { eventType: "dormancy_outreach", recipientRef: r.id, templateId: "dormancy_outreach" });
    }
    return rows.length;
  });

  // Terminal rejected/declined rows: soft-delete after the retention window. The CNPJ
  // denylist (written at rejection) keeps re-signup blocked; NO proactive email ever.
  const retention = await pool.query(
    `update orgs set deleted_at = now(), updated_at = now()
      where state in ('declined','rejected') and deleted_at is null
        and updated_at < now() - interval '${RETENTION_SOFTDELETE_DAYS} days'
      returning id`,
  );
  for (const r of retention.rows as { id: string }[]) {
    await pool.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'system', null, 'org.retention_softdelete', '{}')`,
      [r.id],
    );
  }

  const dropped = await pool.query(`delete from rate_limits where window_start < now() - interval '1 day'`);

  return {
    warned60,
    warned80,
    expired,
    dormancyPinged,
    retentionDeleted: retention.rowCount ?? 0,
    rateWindowsDropped: dropped.rowCount ?? 0,
  };
}
