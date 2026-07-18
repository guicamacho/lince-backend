/**
 * 24h post-recovery money-out hold (ruling PRD-07 v5, 2026-07-04).
 *
 * After a full account recovery (all factors replaced) money-out is held for 24h. The
 * ratified control is a TIME-BASED AUTO-EXPIRY — the hold is never mutated or cleared by
 * ops — so it needs no mutable store and no new migration. The durable seam is an
 * append-only `audit_log` event: `security.post_recovery_hold` with `payload.until`.
 * (audit_log is append-only via trg_audit_append_only; a time-expiring event never
 * fights that trigger, and the same row is visible later in Org 360.)
 *
 * ponytail: recovery hold = a time-expiring audit_log event; zero new schema. If the
 * policy ever flips to ops-case-clear (mutable), add a hold table (migration) — do not
 * build now (ruling = 24h auto).
 *
 * Trigger (Cluster 2, 2026-07-18): clerkSync diffs each user.updated against the stored
 * people.security_snapshot — second-factor removal or a primary-email swap registers the
 * hold for every org the person can act in. Consumers: runMoneyLoop (convert + payout)
 * and beneficiary-create.
 */
import type pg from "pg";
import { pool } from "../../db/pool.js";

/** Ratified window (PRD-07 v5 ruling, 2026-07-04). */
export const RECOVERY_HOLD_HOURS = 24;

type Queryable = Pick<pg.PoolClient, "query">;

export interface RecoveryHoldPayload {
  until: string; // ISO-8601 instant the hold expires
}

/**
 * Pure: is money-out held at `now`? True while `now` is before `payload.until`.
 * No payload (org never had a hold) => not held.
 */
export function isMoneyOutHeld(payload: RecoveryHoldPayload | null | undefined, now: Date): boolean {
  if (!payload?.until) return false;
  return now.getTime() < new Date(payload.until).getTime();
}

/**
 * Write a post-recovery hold as an append-only audit_log event. `holdHours` is the
 * ratified window (24h) passed as config. Returns the ISO `until` it recorded.
 */
export async function registerPostRecoveryHold(
  orgId: string,
  holdHours: number,
  userId?: string | null,
  q: Queryable = pool,
): Promise<string> {
  const until = new Date(Date.now() + holdHours * 3_600_000).toISOString();
  await q.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, 'system', $2, 'security.post_recovery_hold', $3)`,
    [orgId, userId ?? null, JSON.stringify({ until })],
  );
  return until;
}

/** Read the org's latest post-recovery hold and evaluate it against `now`.
 *  Accepts the caller's tx client so the money loop checks inside its reservation tx. */
export async function moneyOutHoldActive(orgId: string, now: Date = new Date(), q: Queryable = pool): Promise<boolean> {
  const { rows } = await q.query<{ payload: RecoveryHoldPayload }>(
    `select payload from audit_log
      where org_id = $1 and event = 'security.post_recovery_hold'
      order by created_at desc
      limit 1`,
    [orgId],
  );
  return isMoneyOutHeld(rows[0]?.payload, now);
}
