-- migration 0007 — application rate-limit store (PRD-07 §1, WP-B13).
-- Fixed-window counters behind the future RateLimiter port; daily job prunes stale windows.
-- Verified: UNIQUE (org_id, idem_key) on org_transactions ALREADY EXISTS in 0001 — not re-added.
-- Deferred to WP-B14 (Session 2, user-ratified): payload_hash column + the CNPJ
-- partial-unique-over-non-terminal-states index — they land with the tests that prove them.
create table rate_limits (
  key          text not null,
  route_class  text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, route_class, window_start)
);
-- Fixed-window increment (B13): insert ... on conflict (key,route_class,window_start)
--   do update set count = rate_limits.count + 1 returning count;
-- Daily cleanup (cron later): delete from rate_limits where window_start < now() - interval '2 days';
