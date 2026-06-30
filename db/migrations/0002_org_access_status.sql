-- migration 0002 — org access control (suspend / block). Admin Design Handover §7.
-- Backs the "Inativa" status (admin block vs avenia_relay) and the AUSTRAC freeze/exit
-- seam (255033346 §3). Operational-vs-regulated split recorded via access_source.
-- Existing rows default to 'active', so no one is locked out by this migration.
alter table orgs
  add column access_status text not null default 'active'
    check (access_status in ('active', 'suspended', 'blocked')),
  add column access_reason text,
  add column access_source text
    check (access_source in ('lince_operational', 'avenia_relay')),
  add column access_changed_by uuid references admin_users(id),
  add column access_changed_at timestamptz;

create index orgs_access_status_ix on orgs (access_status) where access_status <> 'active';
