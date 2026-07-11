-- Customer document uploads (EDD / onboarding RFI docs). DECISION 2026-07-11: documents live on
-- DIDIT; Lince retains NOTHING at rest — this table holds ONLY a reference + status, never the
-- file bytes (Modelo A / LGPD posture preserved). Ops forwards to Avenia manually. The real
-- Didit document API is gated on vendor confirmation, so submission is mocked for now.
create table document_uploads (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  case_id       uuid references cases(id),                 -- the RFI/EDD case the doc answers
  uploaded_by   uuid references people(id),
  filename      text not null,
  content_type  text not null,
  size_bytes    bigint not null,
  didit_ref     text,                                      -- Didit's reference (mock for now); NO bytes here
  status        text not null default 'received'
                check (status in ('received','forwarded','failed')),
  created_at    timestamptz not null default now()
);
create index document_uploads_org_ix on document_uploads (org_id, created_at desc);
create index document_uploads_case_ix on document_uploads (case_id);
