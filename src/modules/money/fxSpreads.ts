/**
 * FX spread schedule (PRD-09 phases 1–3) — a COMMISSION SCHEDULE, never a Lince FX price.
 *
 * Modelo A guard-rails: Lince stores per-client spreads in bps; Avenia (the FX principal)
 * applies them as its Markup Fee and remits the proceeds as commission (phase 4, gated on
 * counsel + Avenia config confirmation — question pack A1/C3). Until those gates clear,
 * this schedule only drives the DISPLAY board behind FX_SPREADS_DISPLAY, which stays OFF
 * so the number shown always equals the number transacted.
 *
 * Sign convention (§3): the spread always worsens the customer's side —
 *   buy  (customer pays BRL for USD/EUR): effective = base × (1 + bps/10000)
 *   sell (customer gives USD/EUR for BRL): effective = base × (1 − bps/10000)
 */
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import type { Rates } from "./rates.service.js";

export const SPREAD_PAIRS = ["USD", "EUR"] as const;
export const SPREAD_DIRECTIONS = ["buy", "sell"] as const;
export type SpreadPair = (typeof SPREAD_PAIRS)[number];
export type SpreadDirection = (typeof SPREAD_DIRECTIONS)[number];
/** Fat-finger cap, mirrored in the DB CHECK (0018). */
export const MAX_SPREAD_BPS = 1000;

export type SpreadSchedule = Record<SpreadPair, Record<SpreadDirection, number>>;

const ZERO: SpreadSchedule = { USD: { buy: 0, sell: 0 }, EUR: { buy: 0, sell: 0 } };

/** The org's effective schedule: override row if present, else the default row, else 0. */
export async function getEffectiveSpreads(orgId: string): Promise<SpreadSchedule> {
  const { rows } = await pool.query<{ org_id: string | null; pair: SpreadPair; direction: SpreadDirection; spread_bps: number }>(
    `select org_id, pair, direction, spread_bps from fx_spreads where org_id = $1 or org_id is null`,
    [orgId],
  );
  const out: SpreadSchedule = structuredClone(ZERO);
  // defaults first, then org rows overwrite
  for (const phase of [null, orgId]) {
    for (const r of rows) {
      if (r.org_id === phase) out[r.pair][r.direction] = r.spread_bps;
    }
  }
  return out;
}

export interface SpreadRow {
  orgId: string | null;
  razaoSocial: string | null;
  pair: SpreadPair;
  direction: SpreadDirection;
  spreadBps: number;
  updatedBy: string | null;
  updatedAt: string;
}

/** Admin view: the default schedule + every override, org-labelled. */
export async function listSpreadConfig(): Promise<SpreadRow[]> {
  const { rows } = await pool.query<{
    org_id: string | null; razao_social: string | null; pair: SpreadPair; direction: SpreadDirection;
    spread_bps: number; updated_by: string | null; updated_at: string;
  }>(
    `select s.org_id, o.razao_social, s.pair, s.direction, s.spread_bps, s.updated_by, s.updated_at
       from fx_spreads s left join orgs o on o.id = s.org_id
      order by s.org_id nulls first, s.pair, s.direction`,
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    razaoSocial: r.razao_social,
    pair: r.pair,
    direction: r.direction,
    spreadBps: r.spread_bps,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }));
}

/**
 * Set (upsert) or clear (spreadBps null) one schedule cell. Every change writes the
 * audit event with old → new — no silent rate changes (PRD-09 §5).
 */
export async function setSpread(input: {
  orgId: string | null;
  pair: string;
  direction: string;
  spreadBps: number | null; // null clears an override (default rows can only be set, not cleared)
  adminId: string;
}): Promise<void> {
  if (!SPREAD_PAIRS.includes(input.pair as SpreadPair)) throw new HttpError("invalid_pair", 422);
  if (!SPREAD_DIRECTIONS.includes(input.direction as SpreadDirection)) throw new HttpError("invalid_direction", 422);
  if (input.spreadBps !== null) {
    if (!Number.isInteger(input.spreadBps) || input.spreadBps < 0 || input.spreadBps > MAX_SPREAD_BPS) {
      throw new HttpError("invalid_spread_bps", 422);
    }
  } else if (input.orgId === null) {
    throw new HttpError("cannot_clear_default", 422); // set the default to 0 instead
  }

  const prev = await pool.query<{ spread_bps: number }>(
    `select spread_bps from fx_spreads where coalesce(org_id::text,'default') = coalesce($1,'default') and pair = $2 and direction = $3`,
    [input.orgId, input.pair, input.direction],
  );
  const oldBps = prev.rows[0]?.spread_bps ?? null;

  if (input.spreadBps === null) {
    await pool.query(`delete from fx_spreads where org_id = $1 and pair = $2 and direction = $3`, [
      input.orgId, input.pair, input.direction,
    ]);
  } else {
    await pool.query(
      `insert into fx_spreads (org_id, pair, direction, spread_bps, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (coalesce(org_id::text,'default'), pair, direction)
       do update set spread_bps = $4, updated_by = $5, updated_at = now()`,
      [input.orgId, input.pair, input.direction, input.spreadBps, input.adminId],
    );
  }
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, 'ops', $2, 'admin.fx_spread_changed', $3)`,
    [input.orgId, input.adminId, JSON.stringify({
      pair: input.pair, direction: input.direction, oldBps, newBps: input.spreadBps,
      scope: input.orgId ? "override" : "default",
    })],
  );
}

const withBps = (rate: number | null, bps: number, dir: SpreadDirection): number | null =>
  rate === null ? null : rate * (1 + (dir === "buy" ? bps : -bps) / 10_000);

/**
 * Pure: apply the schedule to the shared-cache BASE rates for one org's view. The mid
 * reference is untouched; `differentiated` tells the UI to switch to "Sua taxa" copy.
 */
export function applySpreads(base: Rates, spreads: SpreadSchedule): Rates & { differentiated: boolean } {
  const differentiated = Object.values(spreads).some((d) => d.buy > 0 || d.sell > 0);
  return {
    ...base,
    brlUsd: {
      buy: withBps(base.brlUsd.buy, spreads.USD.buy, "buy"),
      sell: withBps(base.brlUsd.sell, spreads.USD.sell, "sell"),
      mid: base.brlUsd.mid,
    },
    brlEur: { buy: withBps(base.brlEur.buy, spreads.EUR.buy, "buy"), mid: base.brlEur.mid },
    differentiated,
  };
}
