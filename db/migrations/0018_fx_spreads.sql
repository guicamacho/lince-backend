-- 0018 — PRD-09 phase 1: the per-client commission schedule (spread over live rate, bps).
-- Modelo A: this stores a COMMISSION SCHEDULE Avenia applies as its Markup Fee — never a
-- Lince FX price. org_id NULL = the global default row; an org row overrides it.
create table fx_spreads (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references orgs(id),               -- NULL = global default
  pair       text not null check (pair in ('USD','EUR')),
  direction  text not null check (direction in ('buy','sell')),
  -- fat-finger cap 1000 bps = 10% (PRD-09 §8 proposal; raise only by migration)
  spread_bps int  not null check (spread_bps >= 0 and spread_bps <= 1000),
  updated_by text,                                   -- verified admin id
  updated_at timestamptz not null default now()
);
create unique index fx_spreads_uq on fx_spreads (coalesce(org_id::text, 'default'), pair, direction);
