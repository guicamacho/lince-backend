/**
 * RateLimiter port (PRD-07 §1, WP-B13) + the Postgres fixed-window implementation.
 *
 * One `check` = one window increment for one (key, class) pair. Callers that enforce
 * several tiers on a request (e.g. per-minute AND per-day) call `check` once per tier
 * with the tier's own key/limit/window (see middleware.ts). The port is the seam:
 * a Redis / sliding-window store swaps in behind it later without touching callers.
 */
import type pg from "pg";
import { pool } from "../../db/pool.js";

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the current window ends (0 when allowed). Feeds the Retry-After header. */
  retryAfter: number;
}

export interface RateLimiter {
  check(key: string, routeClass: string, limit: number, windowSeconds: number, now?: number): Promise<RateDecision>;
}

export class PostgresRateLimiter implements RateLimiter {
  // `db` is injectable for tests; defaults to the shared pool.
  constructor(private readonly db: Pick<pg.Pool, "query"> = pool) {}

  async check(
    key: string,
    routeClass: string,
    limit: number,
    windowSeconds: number,
    now = Date.now(),
  ): Promise<RateDecision> {
    const windowMs = windowSeconds * 1000;
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    // Fixed-window UPSERT (migration 0007): atomically bump this window's counter and
    // read the post-increment count. The PK (key, route_class, window_start) keeps
    // distinct tiers/windows from colliding — a per-minute and per-day tier of the same
    // class land on different window_start rows.
    const { rows } = await this.db.query<{ count: number }>(
      `insert into rate_limits (key, route_class, window_start, count)
       values ($1, $2, $3, 1)
       on conflict (key, route_class, window_start)
       do update set count = rate_limits.count + 1
       returning count`,
      [key, routeClass, new Date(windowStartMs)],
    );
    const count = rows[0]!.count;
    const allowed = count <= limit;
    const retryAfter = allowed ? 0 : Math.ceil((windowStartMs + windowMs - now) / 1000);
    return { allowed, retryAfter };
    // ponytail: fixed-window (accepted at MVP per PRD-07); swap Redis + sliding-window
    // behind this same port later — do NOT build now (PRD-07 open #3).
  }
}
