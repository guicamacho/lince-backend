/**
 * Double-entry ledger core — the spine of all money.
 *
 *  * Amounts are signed bigint minor units. + debit / - credit.
 *  * Every transaction sums to ZERO per currency. This is ALSO enforced in the DB by a
 *    deferred constraint trigger (trg_ledger_balanced) — the check here is a fast-fail,
 *    the DB is the floor of truth.
 *  * Balance = SUM(postings.amount). There is NO balance column anywhere — nothing to drift.
 *  * ledger_transactions / ledger_postings are append-only (DB triggers forbid UPDATE/DELETE).
 *    Corrections are reversing entries, never edits.
 */
import type pg from "pg";
import { withTransaction, pool } from "../../db/pool.js";
import type { Currency } from "../../money/money.js";
import { DuplicateLedgerPostError, type PostBalancedTransactionInput, type LedgerAccountType } from "./ledger.types.js";

function assertBalancedPerCurrency(input: PostBalancedTransactionInput): void {
  const sums = new Map<string, bigint>();
  for (const p of input.postings) {
    sums.set(p.currency, (sums.get(p.currency) ?? 0n) + p.amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n) throw new Error(`ledger transaction not balanced for ${currency}: net ${sum}`);
  }
  if (input.postings.length < 2) throw new Error("a ledger transaction needs at least two postings");
}

/** Client-scoped variant: posts inside the CALLER's transaction, so money-state changes
 *  and their postings commit (or roll back) atomically — e.g. deposit settle. */
export async function postBalancedTransactionOn(
  client: pg.PoolClient,
  input: PostBalancedTransactionInput,
): Promise<string> {
  assertBalancedPerCurrency(input);
  // The keyed insert runs under a SAVEPOINT: a 23505 aborts the pg transaction until rolled
  // back, and callers that swallow DuplicateLedgerPostError (ticketApply) must be able to keep
  // using this client — without the savepoint every later statement dies with 25P02.
  const keyed = !!input.idempotencyKey;
  if (keyed) await client.query("savepoint ledger_post");
  let rows: { id: string }[];
  try {
    ({ rows } = await client.query<{ id: string }>(
      "insert into ledger_transactions (description, org_transaction_id, idempotency_key) values ($1,$2,$3) returning id",
      [input.description, input.orgTransactionId ?? null, input.idempotencyKey ?? null],
    ));
  } catch (e) {
    // Exactly-once backstop: a second post with the same idempotency_key hits ledger_tx_idempotency_uq.
    if (keyed && (e as { code?: string }).code === "23505") {
      await client.query("rollback to savepoint ledger_post");
      throw new DuplicateLedgerPostError(input.idempotencyKey!);
    }
    throw e;
  }
  if (keyed) await client.query("release savepoint ledger_post");
  const ledgerTxId = rows[0]!.id;
  for (const p of input.postings) {
    await client.query(
      "insert into ledger_postings (ledger_tx_id, account_id, amount, currency) values ($1,$2,$3,$4)",
      [ledgerTxId, p.accountId, p.amount.toString(), p.currency],
    );
  }
  // commit triggers trg_ledger_balanced (deferred) — a bug here aborts the tx at the DB.
  return ledgerTxId;
}

export async function postBalancedTransaction(input: PostBalancedTransactionInput): Promise<string> {
  return withTransaction((client: pg.PoolClient) => postBalancedTransactionOn(client, input));
}

/** Get-or-create a ledger account by its unique key (idempotent; same client/tx as the caller). */
export async function ensureAccount(
  client: pg.PoolClient,
  input: { key: string; type: LedgerAccountType; orgId?: string | null; currency: Currency },
): Promise<string> {
  const ins = await client.query<{ id: string }>(
    `insert into ledger_accounts (key, type, org_id, currency) values ($1,$2,$3,$4)
     on conflict (key) do nothing returning id`,
    [input.key, input.type, input.orgId ?? null, input.currency],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const sel = await client.query<{ id: string }>("select id from ledger_accounts where key = $1", [input.key]);
  return sel.rows[0]!.id;
}

/** Customer-visible balances for an org: per-currency NEGATED sum of its liability
 *  accounts' postings (liabilities carry credit balances; the customer sees them positive). */
// ponytail: Number() narrows the bigint balance for JSON. Safe within bounds: each deposit is
// capped at MAX_MINOR (10^13) by parseCustomerAmount, and 2^53 ≈ 9.0×10^15 minor units, so an
// org would need hundreds of max-cap deposits to lose precision. Serialize as string if BRLA
// balances ever approach that (they won't in BR PJ payments).
export async function balancesForOrg(orgId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ currency: string; bal: string }>(
    `select a.currency, coalesce(-sum(p.amount), 0)::text as bal
       from ledger_accounts a
       left join ledger_postings p on p.account_id = a.id
      where a.org_id = $1 and a.type = 'customer_liability'
      group by a.currency`,
    [orgId],
  );
  return Object.fromEntries(rows.map((r) => [r.currency, Number(r.bal)]));
}

/** Balance of an account = SUM of its postings (per currency). */
export async function balanceOf(accountId: string, currency: Currency): Promise<bigint> {
  const { rows } = await pool.query<{ bal: string | null }>(
    "select sum(amount)::text as bal from ledger_postings where account_id = $1 and currency = $2",
    [accountId, currency],
  );
  return BigInt(rows[0]?.bal ?? "0");
}
