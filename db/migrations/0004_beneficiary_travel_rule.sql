-- migration 0004 — travel-rule capture on beneficiaries. AUSTRAC §4 (255033346).
-- Billr captures and RETAINS the travel-rule tracing info (payee details + the payer's
-- authorising individual + purpose), forwarded to Avenia later (mocked in P1).
-- avenia_beneficiary_id becomes nullable: the record is captured locally before forwarding.
alter table avenia_beneficiaries
  alter column avenia_beneficiary_id drop not null,
  add column payee_legal_name   text,
  add column payee_country       text,
  add column payee_bank_psp       text,
  add column payee_account        text,   -- IBAN / account / wallet identifier (tracing info)
  add column payee_memo           text,   -- memo / destination tag (optional)
  add column purpose_of_payment   text,
  add column source_of_funds      text,
  add column authorised_by        uuid references people(id);  -- the authorising individual (payer)
