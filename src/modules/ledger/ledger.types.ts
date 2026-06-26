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
  postings: PostingInput[];
}
