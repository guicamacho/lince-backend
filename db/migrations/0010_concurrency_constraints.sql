-- PRD-07 §2 constraints block. Authored as 0010 (PRD says "0007"; 0007 already shipped rate_limits).
-- avenia_accounts(org_id), org_people(org_id,person_id), org_transactions(org_id,idem_key) already
-- exist as PK/unique (verified 0001) -> NOT re-added.

-- 5) idempotency payload binding (PRD-07 §2 pattern 5): differing hash on same idem_key => 409.
alter table org_transactions
  add column payload_hash text;              -- sha256 hex of the canonical ticket-create request; null on legacy/deposit rows

-- 9) CNPJ uniqueness only over NON-TERMINAL lifecycle states (PRD-07 §2 pattern 9 + constraints block).
--    Existing orgs_cnpj_live_uq blocks rejected/declined from re-onboarding; PRD wants them excluded
--    (rejections stay blocked separately via cnpj_denylist; re-onboarding after voluntary closure
--    [= deleted_at set] allowed by default -- open item #5). deleted_at IS NULL already drops closed rows.
drop index if exists orgs_cnpj_live_uq;
create unique index orgs_cnpj_active_uq on orgs (cnpj)
  where deleted_at is null and state not in ('rejected','declined');
