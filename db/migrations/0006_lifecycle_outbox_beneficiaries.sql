-- migration 0006 — lifecycle close-out + webhook resilience + notification outbox
--                  + beneficiary change-control delta + cases.type operational re-cut.
-- Refs: PRD-01 §13.1, Avenia §9 / PRD-07 §2, PRD-06 §2A, PRD-03 §13.2, PRD-04 §4.7.

-- 1) orgs: terminal 'closed' (PRD-03 never-delete) + 7-year retention anchor (PRD-01 §13.1).
alter table orgs add column closed_at timestamptz;
alter table orgs drop constraint orgs_state_check;
alter table orgs add constraint orgs_state_check
  check (state in ('pending_lince_approval','kyb_in_progress','vendor_pending',
                   'rfi_required','active','declined','rejected','closed'));

-- 2) webhook_events: dead-letter + retry accounting (Avenia §9; PRD-07 §2).
--    Pre-flight: zero rows have status='ignored' (verified); no code path sets status.
alter table webhook_events add column attempts int not null default 0;
alter table webhook_events add column last_error text;
alter table webhook_events drop constraint webhook_events_status_check;
alter table webhook_events add constraint webhook_events_status_check
  check (status in ('received','processed','failed','dead'));

-- 3) notification_outbox (PRD-06 §2A) — enqueued in caller's txn; drained by B6 (SKIP LOCKED).
create table notification_outbox (
  id               uuid primary key default gen_random_uuid(),
  event_type       text not null,
  recipient_ref    text not null,
  template_id      text not null,
  template_version int,
  payload          jsonb not null default '{}',
  status           text not null default 'queued'
                   check (status in ('queued','sent','failed','dead')),
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  audit_ref        text
);
create index notification_outbox_queued_ix on notification_outbox (created_at) where status = 'queued';

-- 4) avenia_beneficiaries delta — beneficiary change control (PRD-03 §13.2).
alter table avenia_beneficiaries
  add column destination_kind text
    check (destination_kind in ('pix_key','bank_account','iban','wallet','brcode')),
  add column verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','changed_pending')),
  add column verified_at timestamptz,
  add column destination_changed_at timestamptz;

-- 5) cases.type re-cut to the operational taxonomy (PRD-04 §4.7 + G-series). Superset → safe.
--    No AUSTRAC suspicious-matter type — gated on counsel #1.
alter table cases drop constraint cases_type_check;
alter table cases add constraint cases_type_check
  check (type in ('kyb_completeness','avenia_decision_relay','rfi_relay','beneficiary_review',
                  'support','manual_review','recon_break','customer_dispute',
                  'customer_inquiry','dormant_review'));
