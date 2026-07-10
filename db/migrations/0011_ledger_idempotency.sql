-- Exactly-once DB backstop for ledger transactions (audit finding, 2026-07-11).
-- Deposit-settle postings are guarded in-code by a row lock + the monotonic ticket-state
-- guard, but that is advisory. A nullable, unique idempotency_key makes double-posting a
-- specific money event impossible at the DB even if the in-code guard regresses.
alter table ledger_transactions add column idempotency_key text;
create unique index ledger_tx_idempotency_uq on ledger_transactions (idempotency_key)
  where idempotency_key is not null;
