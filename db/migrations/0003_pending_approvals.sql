-- migration 0003 — maker-checker queue. Admin Design Handover §7 / AUSTRAC hold seam
-- (255033346 §3). A gated action (admission relay, org block, reversal, role grant)
-- commits only on a SECOND operator's approval: decided_by must differ from requested_by.
-- Seam only — created so the surface can switch on without re-architecture; no consumer wired yet.
create table pending_approvals (
  id           uuid primary key default gen_random_uuid(),
  action_type  text not null check (action_type in ('admission_relay', 'org_block', 'reversal', 'role_grant')),
  target_ref   text not null,
  payload      jsonb not null default '{}'::jsonb,
  requested_by uuid not null references admin_users(id),
  requested_at timestamptz not null default now(),
  decided_by   uuid references admin_users(id),
  decided_at   timestamptz,
  decision     text check (decision in ('approved', 'declined')),
  remark       text,
  constraint pending_approvals_maker_checker check (decided_by is null or decided_by <> requested_by)
);

create index pending_approvals_open_ix on pending_approvals (requested_at) where decided_at is null;
