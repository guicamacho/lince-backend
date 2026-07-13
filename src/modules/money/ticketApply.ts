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
import { DuplicateLedgerPostError } from "../ledger/ledger.types.js";
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
  source_currency: string | null;
  source_amount: string | null; // bigint comes back as string from pg
  dest_currency: string | null;
  dest_amount: string | null;
  quote: { ticketStatus?: string } | null;
}

export const APPLY_ROW_COLUMNS = "id, org_id, type, source_currency, source_amount, dest_currency, dest_amount, quote";

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
    try {
      await postBalancedTransactionOn(client, {
        description: `deposit settled (ticket actuals)`,
        orgTransactionId: tx.id,
        idempotencyKey: `deposit-settle:${tx.id}`, // exactly-once DB backstop
        postings: [
          { accountId: custody, amount: net, currency },
          { accountId: orgAccount, amount: -net, currency },
        ],
      });
    } catch (e) {
      // Already posted for this deposit (in-code guard regressed / raced): the state UPDATE
      // above is idempotent, so swallow and treat as applied — never double-credit the ledger.
      if (!(e instanceof DuplicateLedgerPostError)) throw e;
    }
  }

  // Convert settle (PRD-10): a swap reshapes existing custody — the customer gives up `in` of the
  // source currency and receives `out` of the destination. Four postings, balanced PER CURRENCY:
  //   src: -in custody (vendor holds less src)   +in  org liability (customer holds less src)
  //   dst: +out custody (vendor holds more dst)  -out org liability (customer holds more dst)
  // Amounts are the ticket ACTUALS (fees baked in, as with deposits). Markup income leg = PRD-09.
  if (
    nextState === "settled" && tx.type === "convert_and_send" &&
    tx.source_amount && tx.source_currency && tx.dest_amount && tx.dest_currency
  ) {
    const srcCcy = tx.source_currency as Currency;
    const dstCcy = tx.dest_currency as Currency;
    const inAmt = BigInt(tx.source_amount);
    const outAmt = BigInt(tx.dest_amount);
    const custodySrc = await ensureAccount(client, { key: `avenia:custody:${srcCcy}`, type: "vendor_asset", currency: srcCcy });
    const custodyDst = await ensureAccount(client, { key: `avenia:custody:${dstCcy}`, type: "vendor_asset", currency: dstCcy });
    const orgSrc = await ensureAccount(client, { key: `org:${tx.org_id}:${srcCcy}`, type: "customer_liability", orgId: tx.org_id, currency: srcCcy });
    const orgDst = await ensureAccount(client, { key: `org:${tx.org_id}:${dstCcy}`, type: "customer_liability", orgId: tx.org_id, currency: dstCcy });
    try {
      await postBalancedTransactionOn(client, {
        description: `convert settled (ticket actuals)`,
        orgTransactionId: tx.id,
        idempotencyKey: `convert-settle:${tx.id}`,
        postings: [
          { accountId: custodySrc, amount: -inAmt, currency: srcCcy },
          { accountId: orgSrc, amount: inAmt, currency: srcCcy },
          { accountId: custodyDst, amount: outAmt, currency: dstCcy },
          { accountId: orgDst, amount: -outAmt, currency: dstCcy },
        ],
      });
    } catch (e) {
      if (!(e instanceof DuplicateLedgerPostError)) throw e; // idempotent replay — never double-post
    }
  }
  return "apply";
}
