/**
 * The ONE place an Avenia ticket status becomes an org_transactions state change.
 * Callers: the webhook processor (event-driven) and the deposit reconciler (poll backstop
 * for missed/undeliverable webhooks — also the only path in local dev, where webhooks
 * are registered against the deployed endpoint). Both hold the row lock when calling.
 */
import type pg from "pg";
import { ticketTransitionAllowed, normalizeTicketStatus } from "../webhooks/ticketState.js";
import type { TicketState } from "../providers/provider.types.js";

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

/** Apply a wire-format ticket status to a locked org_transactions row. Returns what happened. */
export async function applyTicketStatus(
  client: pg.PoolClient,
  tx: { id: string; quote: { ticketStatus?: string } | null },
  wireStatus: string,
): Promise<"apply" | "ignore" | "reject"> {
  const incoming = normalizeTicketStatus(wireStatus);
  const current = (tx.quote?.ticketStatus ?? null) as TicketState | null;
  const decision = ticketTransitionAllowed(current, incoming);
  if (decision !== "apply") return decision;
  await client.query(
    `update org_transactions
        set state = $2,
            quote = coalesce(quote, '{}'::jsonb) || jsonb_build_object('ticketStatus', $3::text),
            updated_at = now()
      where id = $1`,
    [tx.id, TICKET_TO_TX_STATE[incoming] ?? "executing", incoming],
  );
  return "apply";
}
