-- ============================================================
-- Lince Finance — Phase 1 schema — CONSOLIDATED v1.1 (Modelo A)
-- Postgres 15+. Single greenfield migration: base 15 tables
-- + v1.0 additions + v1.1 (Modelo A + Didit + multi-region),
-- folded into FINAL state (tables born correct — no ALTER chain).
-- 18 tables.
--
-- Conventions: uuid PKs, timestamptz, money = signed BIGINT minor
-- units, text+CHECK over enums, jsonb only where shape is vendor-
-- owned, append-only ledger + audit.
--
-- Modelo A invariants encoded here (canon page 250904599):
--   * Lince retains NO KYC PII — no CPF, no per-person KYC verdict,
--     no UBO ownership %, no documents. Didit/Avenia hold the data;
--     Lince holds references + status only.
--   * Admission is Avenia's (BR). orgs.admission_* records the RELAY
--     of Avenia's out-of-band verdict (admission_authority_used,
--     external ref, recording admin) — never a Lince decision.
--   * Per-jurisdiction admission via jurisdiction_policies.
--     BR = avenia (locked). MX/CO rows intentionally NOT seeded
--     (markets gated on local counsel).
--   * No FX spread is stored/earned by Lince (revenue = Avenia rebate).
-- ============================================================

-- ---------- policy (architecture §6) ----------
create table jurisdiction_policies (
  country_code         text primary key,
  mode                 text not null default 'blocked'
                       check (mode in ('conduit','treasury','blocked')),
  holding_currencies   text[] not null default '{}',
  custody_model        text check (custody_model in ('vendor_subaccount','segregated_wallet')),
  contracting_entity   text,
  payin_rails          text[] not null default '{}',
  payout_rails         text[] not null default '{}',
  card_enabled         boolean not null default false,
  -- v1.1 (Modelo A + multi-region): who decides admission, and which KYB provider.
  admission_authority  text not null default 'avenia'
                       check (admission_authority in ('avenia','lince','local_partner')),
  kyb_provider         text not null default 'didit'
                       check (kyb_provider in ('didit')),
  legal_basis          text,
  reviewed_by          text,
  reviewed_at          timestamptz
);

-- BR row: admission_authority = avenia (Modelo A — Avenia decides).
-- MX/CO rows are NOT seeded: those markets are gated on local regulatory
-- analysis (CNBV/Ley Fintech, SFC). Do not add them until counsel sets
-- admission_authority + contracting + AML for each.
insert into jurisdiction_policies
  (country_code, mode, holding_currencies, custody_model, contracting_entity,
   payin_rails, payout_rails, admission_authority, kyb_provider,
   legal_basis, reviewed_by, reviewed_at)
values
  ('BR','conduit','{BRL}','vendor_subaccount','avenia_principal',
   '{avenia_pix}','{avenia_payout}','avenia','didit',
   'Modelo A / BCB Res. 519-520-521 (canon 250904599)','founder', now());

-- ---------- providers (the vendor registry the router reads) ----------
-- Capabilities are MULTI-VALUED: Avenia is payin AND payout. FX folds into the
-- payin/payout legs (not a standalone capability). custody deferred until wallet infra.
create table providers (
  code          text primary key,                       -- 'avenia' | 'tazapay' | 'durianpay'
  display_name  text not null,
  capabilities  text[] not null default '{}',           -- subset of {payin, payout}; 'custody' added with wallet infra
  rails         text[] not null default '{}',           -- e.g. {avenia_pix, avenia_payout}
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    timestamptz not null default now()
);

insert into providers (code, display_name, capabilities, rails) values
  ('avenia','Avenia','{payin,payout}','{avenia_pix,avenia_payout}');

-- one row per (provider × currency × direction). New currency = INSERT, never a migration.
create table provider_currencies (
  provider_code  text not null references providers(code),
  currency       text not null,
  direction      text not null check (direction in ('payin','payout')),
  rail           text,                                   -- optional rail qualifier
  min_minor      bigint,                                 -- optional floor in minor units
  primary key (provider_code, currency, direction)
);

insert into provider_currencies (provider_code, currency, direction, rail) values
  ('avenia','BRL','payin','avenia_pix'),
  ('avenia','USD','payout','avenia_payout'),
  ('avenia','EUR','payout','avenia_payout'),
  ('avenia','USDC','payout','avenia_payout'),
  ('avenia','USDT','payout','avenia_payout');

-- ---------- identity (people + org_people) ----------
-- v1.1 (Modelo A): NO KYC PII. people holds the minimal OPERATIONAL identity
-- (display name, email, phone, locale) + references only.
--   * cpf       -> DROPPED (forwarded to Didit/Avenia, never stored)
--   * kyc_status-> DROPPED (no per-person verdict retained; grain is company-level)
--   * clerk_user_id (v1.0) -> login-user identity key (UNIQUE, nullable;
--                             non-login UBOs have none and are per-org rows)
create table people (
  id            uuid primary key default gen_random_uuid(),
  clerk_user_id text unique,                             -- staff/customer auth via Clerk; null for non-login UBOs
  full_name     text not null,                           -- operational display name
  email         text not null,
  phone         text,
  locale        text not null default 'pt-BR',
  can_login     boolean not null default false,          -- true for reps/admins/finance; false for non-login UBOs
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index people_email_uq on people (lower(email)) where can_login = true;

-- ---------- back-office staff (admin_users) — v1.0 ----------
-- Admin RBAC is SEPARATE from customer RBAC (org_people). Staff auth via Clerk
-- (separate plane). Roles on roles[] (no separate admin_roles table).
-- Declared before orgs because orgs.admission_recorded_by references it.
create table admin_users (
  id            uuid primary key default gen_random_uuid(),
  clerk_user_id text unique,
  email         text not null unique,
  name          text not null,
  roles         text[] not null default '{}',            -- e.g. superadmin, compliance, support, treasury_ops, read_only
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index admin_users_active_ix on admin_users (is_active);

create table orgs (
  id                 uuid primary key default gen_random_uuid(),
  cnpj               text not null,
  razao_social       text not null,
  country_code       text not null references jurisdiction_policies(country_code),
  state              text not null default 'pending_lince_approval'
                     check (state in ('pending_lince_approval','kyb_in_progress',
                                      'vendor_pending','rfi_required','active','declined','rejected')),
  legal_rep_person_id uuid references people(id),
  onboarding         jsonb not null default '{}',         -- in-progress form payload only; purged on submit/terminal (NO KYC PII at rest)
  -- v1.1 (Modelo A): admission-decision record. For BR this records the RELAY
  -- of Avenia's out-of-band verdict; admission_authority_used = 'avenia',
  -- admission_recorded_by = the ops admin who relayed it. NOT a Lince decision.
  admission_state          text not null default 'pending'
                           check (admission_state in ('pending','approved','rejected')),
  admission_authority_used text check (admission_authority_used in ('avenia','lince','local_partner')),
  admission_external_ref   text,                          -- Avenia's reference (BR)
  admission_recorded_by    uuid references admin_users(id),
  admission_recorded_at    timestamptz,
  -- KYB L1 forward timestamp -> drives the admission-aging/SLA instrument (PRD-04 §4.3/§10)
  kyb_forwarded_at         timestamptz,
  activated_at       timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index orgs_cnpj_live_uq on orgs (cnpj) where deleted_at is null;
create index orgs_state_ix on orgs (state) where deleted_at is null;
create index orgs_admission_pending_ix on orgs (kyb_forwarded_at)
  where admission_state = 'pending' and deleted_at is null;   -- aging view

-- the link: one human ↔ one org, with ALL their hats. Multi-org (accountant) = multiple rows.
-- v1.1: status (v1.0) added; ownership_pct DROPPED (UBO ownership % is KYC data
--       forwarded to Avenia/Didit, not retained — PRD-01 v5 §9). Re-add only if a
--       display need outweighs the no-retention posture (flagged for confirmation).
create table org_people (
  org_id        uuid not null references orgs(id),
  person_id     uuid not null references people(id),
  roles         text[] not null default '{}',            -- subset of {owner, legal_rep, admin, finance, viewer, director, ubo}
  status        text not null default 'invited'
                check (status in ('invited','active','suspended')),
  created_at    timestamptz not null default now(),
  primary key (org_id, person_id)
);
-- AT MOST ONE owner per org (v1.0). "At least one" is an app invariant (transfer-only / no-removal, PRD-03).
create unique index uq_one_owner_per_org on org_people (org_id) where 'owner' = any (roles);

-- ---------- vendor accounts (physical per-vendor; option B) ----------
-- Avenia-specific, per-org. References + status only — NO PII.
create table avenia_accounts (
  org_id              uuid primary key references orgs(id),
  subaccount_id       text,                              -- Avenia COMPANY subaccount id
  kyb_l1_attempt_id   text,
  kyb_l1_state        text not null default 'not_started'
                      check (kyb_l1_state in ('not_started','pending','approved','rejected')),
  pofc_state          text not null default 'not_started'  -- Proof of Financial Capacity (USD/EUR prereq)
                      check (pofc_state in ('not_started','pending','approved','rejected')),
  usd_state           text not null default 'not_requested' -- USD fiat payout rail unlock
                      check (usd_state in ('not_requested','pending','approved','rejected')),
  eur_state           text not null default 'not_requested' -- EUR fiat payout rail unlock
                      check (eur_state in ('not_requested','pending','approved','rejected')),
  avenia_meta         jsonb not null default '{}',        -- ubo-id map, transient doc ids, attempt ids, Bridge codes (refs only)
  last_event_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- v1.1: Didit capture/verification reference — thin, per-vendor, mirrors avenia_accounts.
-- References + status ONLY — NO PII (Didit holds the verification data).
create table didit_verifications (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id),
  didit_session_id text,                                 -- Didit session/verification id
  status           text not null default 'launched'
                   check (status in ('launched','awaiting_key_people','completed','failed')),
  decision_ref     text,                                 -- Didit result reference (no PII)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index didit_verifications_org_ix on didit_verifications (org_id);

-- beneficiaries: Avenia owns the record; we keep a thin pointer + display cache.
create table avenia_beneficiaries (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id),
  avenia_beneficiary_id text not null,                   -- the record lives at Avenia
  label              text not null,                      -- display cache for the Beneficiários list
  dest_currency      text,                               -- display cache (masked/summary only)
  dest_hint          text,                               -- e.g. last 4 / masked IBAN for the list
  status             text not null default 'active' check (status in ('active','disabled')),
  created_at         timestamptz not null default now()
);
create index avenia_beneficiaries_org_ix on avenia_beneficiaries (org_id);

-- ---------- ledger (architecture §7) ----------
create table ledger_accounts (
  id        uuid primary key default gen_random_uuid(),
  key       text not null unique,
  type      text not null check (type in ('customer_liability','vendor_asset','clearing','income')),
  org_id    uuid references orgs(id),
  currency  text not null,
  created_at timestamptz not null default now()
);
create index ledger_accounts_org_ix on ledger_accounts (org_id);

create table ledger_transactions (
  id              uuid primary key default gen_random_uuid(),
  org_transaction_id uuid,                               -- FK added after org_transactions exists
  description     text not null,
  created_at      timestamptz not null default now()
);

create table ledger_postings (
  id            uuid primary key default gen_random_uuid(),
  ledger_tx_id  uuid not null references ledger_transactions(id),
  account_id    uuid not null references ledger_accounts(id),
  amount        bigint not null,                         -- signed minor units; Σ per tx per ccy = 0
  currency      text not null,
  created_at    timestamptz not null default now()
);
create index ledger_postings_account_ix on ledger_postings (account_id);
create index ledger_postings_tx_ix on ledger_postings (ledger_tx_id);

-- ---------- money movement ----------
create table org_transactions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id),
  type            text not null check (type in ('deposit','convert_and_send','payout')),
  state           text not null default 'created'
                  check (state in ('created','compliance_check','on_hold','funding',
                                   'executing','settled','failed','reversed','cancelled')),
  initiated_by_user_id uuid references people(id),       -- nullable: deposits are webhook-originated (no human)
  source_currency text,
  source_amount   bigint,
  dest_currency   text,
  dest_amount     bigint,
  fee_amount      bigint,
  fee_currency    text,
  quote           jsonb,
  beneficiary_id  uuid references avenia_beneficiaries(id),
  provider_code   text references providers(code),
  vendor_ref      text,
  idem_key        uuid not null,
  error           jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, idem_key)
);
create index org_transactions_org_created_ix on org_transactions (org_id, created_at desc);
create index org_transactions_state_ix on org_transactions (state)
  where state not in ('settled','failed','reversed','cancelled');
create index org_transactions_initiator_ix on org_transactions (initiated_by_user_id);

alter table ledger_transactions
  add constraint ledger_tx_org_tx_fk
  foreign key (org_transaction_id) references org_transactions(id);

-- ---------- infrastructure ----------
create table cnpj_denylist (
  cnpj        text primary key,
  reason_ref  text not null,
  created_at  timestamptz not null default now()
);

create table webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  provider_code      text not null,                       -- 'avenia' | 'didit' | 'clerk'
  external_event_id  text not null,
  event_type         text not null,
  payload            jsonb not null,
  status             text not null default 'received'
                     check (status in ('received','processed','failed','ignored')),
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  unique (provider_code, external_event_id)
);
create index webhook_events_pending_ix on webhook_events (received_at) where status = 'received';

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references orgs(id),
  actor_type  text not null check (actor_type in ('user','ops','system','vendor')),
  actor_id    text,                                      -- people.id / admin_users.id depending on actor_type
  event       text not null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index audit_log_org_ix on audit_log (org_id, created_at desc);

-- ---------- back-office cases (compliance/ops) — v1.0 table, v1.1 taxonomy ----------
-- v1.1 (Modelo A): OPERATIONAL taxonomy only. AML/sanctions/PEP/PLD-FT are Avenia's
-- domain for BR — they are NOT Lince-owned case types. Any AUSTRAC suspicious-matter
-- (SMR) type is GATED on counsel (canon §5 / PRD-04 §10 Q3) and intentionally absent here.
create table cases (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references orgs(id),             -- nullable for non-org cases
  type              text not null
                      check (type in ('kyb_completeness','avenia_decision_relay','rfi_relay',
                                      'beneficiary_review','support','manual_review')),
  status            text not null default 'open'
                      check (status in ('open','in_review','escalated','closed')),
  priority          text not null default 'normal'
                      check (priority in ('low','normal','high','urgent')),
  assigned_admin_id uuid references admin_users(id),
  opened_by         uuid references admin_users(id),
  summary           text,
  resolution        text,
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz
);
create index cases_org_ix    on cases (org_id);
create index cases_status_ix on cases (status);

-- ============================================================
-- Safety floor
-- ============================================================
create or replace function assert_ledger_tx_balanced() returns trigger
language plpgsql as $$
declare unbalanced int;
begin
  select count(*) into unbalanced from (
    select currency from ledger_postings
    where ledger_tx_id = new.ledger_tx_id
    group by currency having sum(amount) <> 0
  ) x;
  if unbalanced > 0 then
    raise exception 'unbalanced ledger transaction %', new.ledger_tx_id;
  end if;
  return null;
end $$;

create constraint trigger trg_ledger_balanced
  after insert on ledger_postings
  deferrable initially deferred
  for each row execute function assert_ledger_tx_balanced();

create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger trg_postings_append_only
  before update or delete on ledger_postings
  for each row execute function forbid_mutation();
create trigger trg_ledger_tx_append_only
  before update or delete on ledger_transactions
  for each row execute function forbid_mutation();
create trigger trg_audit_append_only
  before update or delete on audit_log
  for each row execute function forbid_mutation();
