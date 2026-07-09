/**
 * The ONE place an Avenia ticket status becomes an org_transactions state change —
 * and, on a deposit's settle, the ledger postings (same db transaction: state + postings
 * commit or roll back together; the monotonic guard makes it exactly-once even when the
 * webhook handler and the poll reconciler race, since both hold the row's FOR UPDATE).
 *
 * Deposit settle posting (Modelo A pass-through — Avenia custodies, Lince mirrors):
 *   +net BRLA  avenia:custody:BRLA          (vendor_asset — funds held at Avenia for customers)
 *   -net BRLA  org:{orgId}:BRLA             (customer_liability — what the customer sees)
 * Amounts come from the ticket's ACTUAL quote (dest_amount = outputAmount). No gross/fee
 * legs: the PIX-in fees are Avenia's and never touch Lince custody; they stay itemized in
 * the quote snapshot. Rebate/markup income legs land with the rebate WP.
 */
import type pg from "pg";
import { ticketTransitionAllowed, normalizeTicketStatus } from "../webhooks/ticketState.js";
import { ensureAccount, postBalancedTransactionOn } from "../ledger/ledger.service.js";
import type { TicketState } from "../providers/provider.types.js";
import type { Currency } from "../../money/money.js";

/** Avenia ticket status -> Lince org_transactions.state (deposit lifecycle). */
export const TICKET_TO_TX_STATE: Record<string, string> = {
  UNPAID: "funding",
  PROCESSING: "executing",
  ON_HOLD: "on_hold",
  PAID: "settled",
  FAILED: "failed",
  PARTIAL_FAILED: "failed",
  CANCELED: "cancelled",
};

export interface ApplyRow {
  id: string;
  org_id: string;
  type: string;
  dest_currency: string | null;
  dest_amount: string | null; // bigint comes back as string from pg
  quote: { ticketStatus?: string } | null;
}

export const APPLY_ROW_COLUMNS = "id, org_id, type, dest_currency, dest_amount, quote";

/** Apply a wire-format ticket status to a locked org_transactions row. Returns what happened. */
export async function applyTicketStatus(
  client: pg.PoolClient,
  tx: ApplyRow,
  wireStatus: string,
): Promise<"apply" | "ignore" | "reject"> {
  const incoming = normalizeTicketStatus(wireStatus);
  const current = (tx.quote?.ticketStatus ?? null) as TicketState | null;
  const decision = ticketTransitionAllowed(current, incoming);
  if (decision !== "apply") return decision;
  const nextState = TICKET_TO_TX_STATE[incoming] ?? "executing";
  await client.query(
    `update org_transactions
        set state = $2,
            quote = coalesce(quote, '{}'::jsonb) || jsonb_build_object('ticketStatus', $3::text),
            updated_at = now()
      where id = $1`,
    [tx.id, nextState, incoming],
  );
  if (nextState === "settled" && tx.type === "deposit" && tx.dest_amount && tx.dest_currency) {
    const currency = tx.dest_currency as Currency;
    const net = BigInt(tx.dest_amount);
    const custody = await ensureAccount(client, {
      key: `avenia:custody:${currency}`, type: "vendor_asset", currency,
    });
    const orgAccount = await ensureAccount(client, {
      key: `org:${tx.org_id}:${currency}`, type: "customer_liability", orgId: tx.org_id, currency,
    });
    await postBalancedTransactionOn(client, {
      description: `deposit settled (ticket actuals)`,
      orgTransactionId: tx.id,
      postings: [
        { accountId: custody, amount: net, currency },
        { accountId: orgAccount, amount: -net, currency },
      ],
    });
  }
  return "apply";
}
