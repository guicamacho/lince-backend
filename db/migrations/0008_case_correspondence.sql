-- migration 0008 — case correspondence thread + customer in-app inbox read model.
-- Refs: PRD-04 §4.7 (operational cases) + §13.1 (dispute intake), PRD-06 §2C (tipping-off),
--       PRD-01 §13.1 (correspondence retention, counsel #3). Modelo A: no KYC PII stored.
-- Customer-visibility is DERIVED FROM cases.type (code allowlist) + the per-message flag below;
-- no cases column is added, and no AML type exists to surface (cases_type_check, gated on counsel #1).

-- 1) case_messages — the correspondence thread. Append-only (7-yr record; counsel #3).
create table case_messages (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references cases(id),
  author_type      text not null check (author_type in ('admin','customer','system')),
  author_id        uuid,                         -- admin_users.id | people.id per author_type;
                                                 -- no FK (two possible tables), like audit_log.actor_id
  body             text not null,
  customer_visible boolean not null default false, -- L2 enforcement point; false = internal note
  created_at       timestamptz not null default now()
);
create index case_messages_case_ix on case_messages (case_id, created_at);
-- Immutable correspondence record (reuses the 0001 function).
create trigger trg_case_messages_append_only
  before update or delete on case_messages
  for each row execute function forbid_mutation();

-- 2) customer_notifications — the org-scoped in-app inbox read model ("Avisos").
--    Tipping-off-safe by construction: rows are only ever written from a customer_visible
--    message, and title/body are neutral copy (never raw staff text). read_at is mutable.
create table customer_notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id),
  kind        text not null check (kind in ('case_message','case_opened')),
  case_id     uuid references cases(id),         -- nullable (future non-case notices)
  title       text not null,                     -- neutral pt-BR, from the copy map (not user text)
  body        text not null,                     -- neutral pt-BR
  read_at     timestamptz,                       -- null = unread (drives the bell badge)
  created_at  timestamptz not null default now()
);
create index customer_notifications_org_ix     on customer_notifications (org_id, created_at desc);
create index customer_notifications_unread_ix  on customer_notifications (org_id) where read_at is null;
