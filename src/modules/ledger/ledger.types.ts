import type { Currency } from "../../money/money.js";

export type LedgerAccountType = "customer_liability" | "vendor_asset" | "clearing" | "income";

/** One leg of a double-entry transaction. +debit / -credit. Σ per currency per tx = 0. */
export interface PostingInput {
  accountId: string;
  amount: bigint; // signed minor units
  currency: Currency;
}

export interface PostBalancedTransactionInput {
  description: string;
  orgTransactionId?: string; // links to org_transactions when money-movement-originated
  /** Unique key for a specific money event (e.g. `deposit-settle:{txId}`). A second post with
   *  the same key hits the DB unique index — the exactly-once backstop. */
  idempotencyKey?: string;
  postings: PostingInput[];
}

/** Thrown when a post with an already-used idempotencyKey is attempted (unique_violation). */
export class DuplicateLedgerPostError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`ledger post already exists for ${idempotencyKey}`);
    this.name = "DuplicateLedgerPostError";
  }
}
