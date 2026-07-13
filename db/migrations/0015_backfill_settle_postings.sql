-- 0015: backfill deposit-settle ledger postings for deposits that settled BEFORE the ledger-postings
-- feature (2026-07-09). Such rows are state='settled' (Concluída) yet have no postings, so their
-- credit is missing from balancesForOrg — the customer sees only their later deposits in the balance.
--
-- Idempotent by construction: keyed on 'deposit-settle:{id}' (the same key ticketApply.ts uses), so a
-- deposit that already posted is skipped by the ON CONFLICT, and only settled deposits with a
-- dest_amount and no existing posting get one. Mirrors the deposit settle: +net avenia:custody:BRLA
-- (vendor_asset) / -net org:{id}:BRLA (customer_liability), balanced per currency.

-- 1) Ensure the custody + per-org liability accounts exist for every affected deposit.
insert into ledger_accounts (key, type, org_id, currency)
select distinct 'avenia:custody:' || t.dest_currency, 'vendor_asset', null::uuid, t.dest_currency
from org_transactions t
where t.type = 'deposit' and t.state = 'settled' and t.dest_amount is not null and t.dest_currency is not null
on conflict (key) do nothing;

insert into ledger_accounts (key, type, org_id, currency)
select distinct 'org:' || t.org_id || ':' || t.dest_currency, 'customer_liability', t.org_id, t.dest_currency
from org_transactions t
where t.type = 'deposit' and t.state = 'settled' and t.dest_amount is not null and t.dest_currency is not null
on conflict (key) do nothing;

-- 2) One ledger_transaction per settled deposit that has NO ledger transaction yet. Gating on the
-- absence of ANY ledger_transaction (not the idempotency key) is essential: a deposit posted before
-- the idempotency migration (0011) has a NULL key, so an ON CONFLICT (idempotency_key) gate alone
-- would miss it and double-post. The ON CONFLICT stays as a second guard.
insert into ledger_transactions (description, org_transaction_id, idempotency_key)
select 'deposit settled (backfill 0015)', t.id, 'deposit-settle:' || t.id
from org_transactions t
where t.type = 'deposit' and t.state = 'settled' and t.dest_amount is not null and t.dest_currency is not null
  and not exists (select 1 from ledger_transactions lt where lt.org_transaction_id = t.id)
on conflict (idempotency_key) where idempotency_key is not null do nothing;

-- 3) The two balanced postings for each ledger_transaction that has none yet (the ones just created).
insert into ledger_postings (ledger_tx_id, account_id, amount, currency)
select lt.id, ca.id, t.dest_amount, t.dest_currency
from ledger_transactions lt
join org_transactions t on t.id = lt.org_transaction_id
join ledger_accounts ca on ca.key = 'avenia:custody:' || t.dest_currency
where lt.idempotency_key = 'deposit-settle:' || t.id
  and t.type = 'deposit' and t.state = 'settled' and t.dest_amount is not null
  and not exists (select 1 from ledger_postings p where p.ledger_tx_id = lt.id)
union all
select lt.id, oa.id, - t.dest_amount, t.dest_currency
from ledger_transactions lt
join org_transactions t on t.id = lt.org_transaction_id
join ledger_accounts oa on oa.key = 'org:' || t.org_id || ':' || t.dest_currency
where lt.idempotency_key = 'deposit-settle:' || t.id
  and t.type = 'deposit' and t.state = 'settled' and t.dest_amount is not null
  and not exists (select 1 from ledger_postings p where p.ledger_tx_id = lt.id);
