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
import type { PostBalancedTransactionInput } from "./ledger.types.js";

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

export async function postBalancedTransaction(input: PostBalancedTransactionInput): Promise<string> {
  assertBalancedPerCurrency(input);
  return withTransaction(async (client: pg.PoolClient) => {
    const { rows } = await client.query<{ id: string }>(
      "insert into ledger_transactions (description, org_transaction_id) values ($1,$2) returning id",
      [input.description, input.orgTransactionId ?? null],
    );
    const ledgerTxId = rows[0]!.id;
    for (const p of input.postings) {
      await client.query(
        "insert into ledger_postings (ledger_tx_id, account_id, amount, currency) values ($1,$2,$3,$4)",
        [ledgerTxId, p.accountId, p.amount.toString(), p.currency],
      );
    }
    // commit triggers trg_ledger_balanced (deferred) — a bug here aborts the tx at the DB.
    return ledgerTxId;
  });
}

/** Balance of an account = SUM of its postings (per currency). */
export async function balanceOf(accountId: string, currency: Currency): Promise<bigint> {
  const { rows } = await pool.query<{ bal: string | null }>(
    "select sum(amount)::text as bal from ledger_postings where account_id = $1 and currency = $2",
    [accountId, currency],
  );
  return BigInt(rows[0]?.bal ?? "0");
}
