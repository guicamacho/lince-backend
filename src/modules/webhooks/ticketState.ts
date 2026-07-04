/**
 * Avenia ticket lifecycle guard — PURE, monotonic + idempotent (mirrors identity/org.state.ts).
 *
 * The rail lifecycle only ever moves forward: UNPAID -> PROCESSING -> {PAID,FAILED,PARTIAL_FAILED}.
 * Webhooks arrive out of order and get re-delivered, so applying an event must:
 *   - apply the first event and any forward move,
 *   - ignore a replay of the same state (idempotent),
 *   - ignore a late/older event or anything after a terminal (monotonic — never regress),
 *   - reject an unknown state off the wire (trust boundary; payloads are unverified strings).
 *
 * This is the whole "idempotent + monotonic" requirement as a pure function — no DB, no live
 * rows. B4 wires the DB apply (state CAS + ledger postings) around this decision.
 */
import type { TicketState } from "../providers/provider.types.js";

export type TicketTransition = "apply" | "ignore" | "reject";

/** Forward-only rank. The three terminals share rank 2 — none regresses to another. */
const TICKET_RANK: Record<TicketState, number> = {
  UNPAID: 0,
  PROCESSING: 1,
  PAID: 2,
  FAILED: 2,
  PARTIAL_FAILED: 2,
};
const TERMINAL_RANK = 2;

/**
 * Decide how to treat an incoming ticket state given the current one.
 * `incoming` is typed `string` on purpose: it comes off an unverified webhook payload.
 */
export function ticketTransitionAllowed(current: TicketState | null, incoming: string): TicketTransition {
  const next = TICKET_RANK[incoming as TicketState];
  if (next === undefined) return "reject"; // unknown state off the wire
  if (current === null) return "apply"; // first event
  if (incoming === current) return "ignore"; // idempotent replay
  const cur = TICKET_RANK[current];
  if (cur === TERMINAL_RANK) return "ignore"; // terminal never regresses (incl. to another terminal)
  if (next < cur) return "ignore"; // late / out-of-order
  return "apply"; // forward
}
