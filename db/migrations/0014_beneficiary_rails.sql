-- Rail-aware beneficiaries (address book for FIAT + CRYPTO). New columns:
--   rail         = pix | ach | fedwire | sepa | swift | crypto  (dedicated; destination_kind
--                  keeps its own 0006 check for the §13.2 change seam)
--   network      = crypto chain (e.g. "TRON (TRC-20)", "Polygon"); null for fiat
--   destination  = jsonb of the rail-specific identifier fields (pixKey/routing/iban/wallet…)
-- dest_currency reused as the ASSET (BRL | USD | EUR | GBP | USDC | USDT). Travel-rule fields and
-- the verification_status seam (0006) are unchanged. Legacy payee_bank_psp/payee_account remain
-- for pre-existing rows; new inserts use the structured model. dest_hint = masked identifier tail.
alter table avenia_beneficiaries
  add column rail        text check (rail in ('pix','ach','fedwire','sepa','swift','crypto')),
  add column network     text,
  add column destination jsonb;
