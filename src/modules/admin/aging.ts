/**
 * Admission aging + latency (A3 / PRD-04 §4.3/§10 Group A). Two native-SQL queries,
 * no app-side date math:
 *   1. the pending queue — orgs in admission_state='pending' ordered by wall-clock elapsed
 *      since kyb_forwarded_at, each flagged breached past the SLA threshold;
 *   2. latency percentiles (p50/p90/p95) over admissions RECORDED in the last 90 days.
 *
 * Elapsed is WALL-CLOCK per canon (business-day math is reserved for IFTI/SMR); the
 * threshold comes from env.sla.admissionDays. Percentiles report in days.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { enqueueNotification } from "../notifications/outbox.js";

export interface AgingRow {
  org_id: string;
  cnpj: string;
  razao_social: string;
  kyb_forwarded_at: Date;
  elapsed_seconds: number;
  breached: boolean;
}

export interface AdmissionAging {
  threshold_days: number;
  pending_count: number;
  breach_count: number;
  pending: AgingRow[];
  latency: { p50_days: number | null; p90_days: number | null; p95_days: number | null; n: number };
}

export async function getAdmissionAging(thresholdDays: number): Promise<AdmissionAging> {
  const pending = await pool.query<AgingRow>(
    `select o.id as org_id, '••••••••••' || right(o.cnpj, 4) as cnpj, o.razao_social, o.kyb_forwarded_at,
            extract(epoch from (now() - o.kyb_forwarded_at))::float8 as elapsed_seconds,
            (now() - o.kyb_forwarded_at) > make_interval(days => $1::int) as breached
       from orgs o
      where o.admission_state = 'pending' and o.deleted_at is null
            and o.kyb_forwarded_at is not null
      order by elapsed_seconds desc`,
    [thresholdDays],
  );

  const latency = await pool.query<{
    p50_days: number | null; p90_days: number | null; p95_days: number | null; n: string;
  }>(
    `select
        percentile_cont(0.5)  within group (order by d) / 86400.0 as p50_days,
        percentile_cont(0.9)  within group (order by d) / 86400.0 as p90_days,
        percentile_cont(0.95) within group (order by d) / 86400.0 as p95_days,
        count(*) as n
      from (
        select extract(epoch from (admission_recorded_at - kyb_forwarded_at))::float8 as d
          from orgs
         where admission_recorded_at is not null and kyb_forwarded_at is not null
           and admission_recorded_at >= now() - interval '90 days'
      ) s`,
  );

  const l = latency.rows[0]!;
  return {
    threshold_days: thresholdDays,
    pending_count: pending.rowCount ?? 0,
    breach_count: pending.rows.filter((r) => r.breached).length,
    pending: pending.rows,
    latency: { p50_days: l.p50_days, p90_days: l.p90_days, p95_days: l.p95_days, n: Number(l.n) },
  };
}

/**
 * Push side of the SLA instrument (Cluster 1): the aging view computes breaches on read,
 * but nobody reads a dashboard at 3am — this sweep (server scheduler, hourly) alerts ops
 * once per breached org. Dedupe = one outbox row per org for event_type 'sla_breach'
 * (recipient_ref carries the org id purely as the dedupe key; SlackAdapter ignores it).
 * Returns how many new alerts were raised.
 */
export async function alertSlaBreachesOnce(thresholdDays: number): Promise<number> {
  return withTransaction(async (c) => {
    const { rows } = await c.query<{ org_id: string; cnpj: string; razao_social: string; elapsed_days: number }>(
      `select o.id as org_id, '••••••••••' || right(o.cnpj, 4) as cnpj, o.razao_social,
              (extract(epoch from (now() - o.kyb_forwarded_at)) / 86400.0)::float8 as elapsed_days
         from orgs o
        where o.admission_state = 'pending' and o.deleted_at is null and o.kyb_forwarded_at is not null
          and (now() - o.kyb_forwarded_at) > make_interval(days => $1::int)
          and not exists (select 1 from notification_outbox n
                           where n.event_type = 'sla_breach' and n.recipient_ref = o.id::text)`,
      [thresholdDays],
    );
    for (const r of rows) {
      await enqueueNotification(c, {
        eventType: "sla_breach",
        recipientRef: r.org_id,
        templateId: "admin_alert",
        payload: {
          title: "sla_breach",
          detail: JSON.stringify({
            orgId: r.org_id,
            cnpj: r.cnpj,
            razaoSocial: r.razao_social,
            elapsedDays: Math.round(r.elapsed_days * 10) / 10,
            thresholdDays,
          }),
        },
      });
    }
    return rows.length;
  });
}
