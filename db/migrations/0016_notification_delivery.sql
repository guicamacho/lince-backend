-- 0016 — Notification delivery integrity (Completion Register, Cluster 1).
--
-- 1) provider_ref: the send adapter's provider-side id (Resend email id), so a bounce
--    webhook can be traced back to the outbox row that caused it.
alter table notification_outbox add column provider_ref text;

-- 2) Suppression list: addresses that hard-bounced or complained. Checked before every
--    customer-class send; a suppressed recipient dead-letters the row instead of sending.
--    Email is stored lowercased (writers must lower()); reason is the provider event kind.
create table notification_suppressions (
  email      text primary key,
  reason     text not null check (reason in ('bounced','complained')),
  source_ref text,                                  -- provider's email id, for tracing
  created_at timestamptz not null default now()
);
