-- 0017 — Cluster 2: the Clerk security snapshot that powers the post-recovery hold trigger.
-- Last-seen auth-security flags per person (two_factor_enabled, primary email id, ...),
-- written on every clerk user.* webhook; the DIFF against it detects factor removal /
-- primary-email swap and registers the 24h money-out hold (PRD-07 §3.5 ruling).
alter table people add column security_snapshot jsonb;
