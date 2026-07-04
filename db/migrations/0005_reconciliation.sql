-- migration 0005 — reconciliation machinery (PRD-04 §13.3 / G18).
create table recon_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  scope        text,
  status       text not null default 'queued'
               check (status in ('queued','running','completed','failed')),
  summary      jsonb not null default '{}'
);
create index recon_runs_status_ix on recon_runs (status);

create table recon_breaks (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references recon_runs(id),
  subaccount_id  text,
  asset          text,
  break_type     text not null
                 check (break_type in ('balance_drift','missing_posting','orphan_posting','delivery_gap')),
  expected_minor bigint,
  actual_minor   bigint,
  status         text not null default 'open'
                 check (status in ('open','investigating','resolved')),
  case_id        uuid references cases(id),                 -- nullable; 'recon_break' type added in 0006
  detected_at    timestamptz not null default now(),
  resolved_by    uuid references admin_users(id),           -- inferred type (spec unspecified)
  resolved_at    timestamptz
);
create index recon_breaks_run_ix on recon_breaks (run_id);
create index recon_breaks_open_ix on recon_breaks (status) where status <> 'resolved';
