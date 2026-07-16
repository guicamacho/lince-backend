/**
 * Convert — standalone currency swap (PRD-10). The customer reshapes their OWN held balance
 * from one currency to another (BRL<->USD, i.e. BRLA<->USDT) and keeps the result. First
 * balance-mutating outbound op, so unlike deposits it runs the PRD-07 §2 money-loop:
 *
 *   Phase 1 (under the per-org advisory money lock): reserve — insert a 'created' row and confirm
 *     settled(src) - Σ(in-flight outbound reservations in src) >= 0, computed in ONE snapshot
 *     query so a concurrent settle can't read-skew it. Overcommit rolls the reservation back.
 *   Phase 2 (NO lock held): Avenia swap quote+ticket, then fill the row. The lock-ordering
 *     invariant (lockKeys.ts) forbids an external call while a lock is held.
 *
 * Settle posts the 4-leg ledger entry in ticketApply.ts (the one place a ticket status becomes
 * postings). Idempotent on (org, idem_key) with payload binding, exactly like deposits.
 *
 * ponytail: crash between the Phase-1 commit and the Avenia call leaves a 'created' reservation
 * that the reconciler recovers by externalId (ticket exists) or that lingers counting against
 * balance (ticket never created). Same tolerance as deposits; upgrade = reconciler expiry of
 * null-ticket 'created' rows older than N minutes.
 * ponytail: the under-lock active re-check (B14) rides on the /app gate's active-membership check
 * today; wire an explicit access_status re-check here when that column/framework lands.
 */
import { createHash } from "node:crypto";
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, vendorMinor, type Currency } from "../../money/money.js";
import { acquireOrgMoneyLock } from "../../db/lockKeys.js";
import { ensureAveniaSubaccount } from "../onboarding/aveniaProvisioning.js";
import { mapVendorFees, type MappedFee } from "./moneyLoop.js";
import type { SwapRail, SubAccountCreator, AccountInfoReader } from "../providers/avenia/avenia.client.js";

export type ConvertClient = SwapRail & SubAccountCreator & AccountInfoReader;

// Verified-live pairs (2026-07-12 probe). USD both ways. EUR (EURC) is a fast-follow — it needs
// a round-trippable EURC<->BRLA pair + an EUR wallet card so a bought balance isn't stranded.
const CONVERT_PAIRS: ReadonlyArray<readonly [Currency, Currency]> = [
  ["BRLA", "USDT"],
  ["USDT", "BRLA"],
];
function pairAllowed(from: string, to: string): from is Currency {
  return CONVERT_PAIRS.some(([f, t]) => f === from && t === to);
}

function canonicalHash(orgId: string, from: string, to: string, amount: string): string {
  return createHash("sha256").update(`${orgId}:convert:${from}:${to}:${amount}`).digest("hex");
}

export interface ConvertReceipt {
  id: string;
  state: string;
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: number; // minor units of the source currency
  destAmount: number | null;
  fees: MappedFee[];
}

interface TxRow {
  id: string;
  state: string;
  payload_hash: string | null;
  source_currency: string;
  source_amount: string;
  dest_currency: string;
  dest_amount: string | null;
  quote: Record<string, unknown> | null;
}

function receiptFrom(row: TxRow): ConvertReceipt {
  const quote = (row.quote ?? {}) as { appliedFees?: unknown };
  return {
    id: row.id,
    state: row.state,
    fromCurrency: row.source_currency,
    toCurrency: row.dest_currency,
    sourceAmount: Number(row.source_amount),
    destAmount: row.dest_amount === null ? null : Number(row.dest_amount),
    fees: mapVendorFees(quote.appliedFees),
  };
}

export async function createConvert(
  orgId: string,
  initiatedByPersonId: string | null,
  input: { from: string; to: string; amount: string; idemKey: string },
  client: ConvertClient | null,
): Promise<ConvertReceipt> {
  if (!client) throw new HttpError("avenia_unavailable", 503);
  if (!pairAllowed(input.from, input.to)) throw new HttpError("unsupported_pair", 422);
  const from = input.from as Currency;
  const to = input.to as Currency;
  const amountMinor = parseCustomerAmount(input.amount, from);
  if (amountMinor === null) throw new HttpError("invalid_amount", 422);
  const hash = canonicalHash(orgId, from, to, input.amount);

  // PHASE 1 — reserve under the per-org money lock (advisory xact lock auto-releases on commit).
  const reservation = await withTransaction(async (c) => {
    await acquireOrgMoneyLock(c, orgId);
    const claim = await c.query<{ id: string }>(
      `insert into org_transactions
         (org_id, type, state, initiated_by_user_id, source_currency, source_amount,
          dest_currency, provider_code, idem_key, payload_hash)
       values ($1, 'convert_and_send', 'created', $2, $3, $4, $5, 'avenia', $6, $7)
       on conflict (org_id, idem_key) do nothing
       returning id`,
      [orgId, initiatedByPersonId, from, amountMinor, to, input.idemKey, hash],
    );
    if (!claim.rowCount) {
      // Replay: return the existing reservation, no new hold, no balance re-check.
      const { rows } = await c.query<TxRow>(
        `select id, state, payload_hash, source_currency, source_amount, dest_currency, dest_amount, quote
           from org_transactions where org_id = $1 and idem_key = $2`,
        [orgId, input.idemKey],
      );
      const existing = rows[0];
      if (!existing) throw new HttpError("convert_conflict_retry", 409);
      if (existing.payload_hash !== hash) throw new HttpError("idem_key_payload_mismatch", 409);
      return { replay: true as const, row: existing };
    }
    // Settled(src) - Σ(in-flight outbound reservations in src), including the row just inserted,
    // in ONE snapshot. < 0 means this reservation overcommits -> throw rolls it back.
    const { rows } = await c.query<{ available: string }>(
      `select
         coalesce((select -sum(p.amount) from ledger_postings p
                     join ledger_accounts a on a.id = p.account_id
                    where a.org_id = $1 and a.type = 'customer_liability' and a.currency = $2), 0)
       - coalesce((select sum(t.source_amount) from org_transactions t
                    where t.org_id = $1 and t.type in ('convert_and_send', 'payout') and t.source_currency = $2
                      and t.state in ('created', 'funding', 'executing', 'on_hold')), 0) as available`,
      [orgId, from],
    );
    if (BigInt(rows[0]!.available) < 0n) throw new HttpError("insufficient_balance", 422);
    return { replay: false as const, txId: claim.rows[0]!.id };
  });
  if (reservation.replay) return receiptFrom(reservation.row);
  const txId = reservation.txId;

  // PHASE 2 — no lock held: subaccount + Avenia swap quote+ticket.
  let result;
  try {
    const sub = await ensureAveniaSubaccount(orgId, client);
    if (!sub) throw new Error("no subaccount");
    result = await client.createSwap({
      subAccountId: sub,
      inputCurrency: from,
      outputCurrency: to,
      inputAmount: input.amount,
      externalId: input.idemKey,
    });
  } catch (e) {
    // Do NOT mark 'failed' here. A swap ticket auto-executes the instant it is created, and
    // createSwap can throw AFTER the ticket POST reached Avenia (lost/truncated response). Marking
    // 'failed' would strand a swap Avenia actually executed (the reconciler skips 'failed' and the
    // PAID webhook can't match a null vendor_ref) — customer money loss. Leave the row 'created' so
    // the reconciler settles the real ticket by externalId if it exists, or releases the reservation
    // when no ticket was ever created (moneyLoop.ts:reconcileInFlightTickets). Record the error only.
    await pool.query(
      `update org_transactions set error = $2, updated_at = now() where id = $1 and state = 'created'`,
      [txId, JSON.stringify({ stage: "create", message: e instanceof Error ? e.message : String(e) })],
    );
    throw e instanceof HttpError ? e : new HttpError("convert_pending_reconcile", 502);
  }

  const destMinor = vendorMinor(result.quote.outputAmount, to);
  const quoteSnapshot = {
    ticketStatus: "UNPAID",
    basePrice: result.quote.basePrice,
    pairName: result.quote.pairName,
    inputAmount: result.quote.inputAmount,
    outputAmount: result.quote.outputAmount,
    appliedFees: result.quote.appliedFees,
  };
  const upd = await pool.query<TxRow>(
    `update org_transactions
        set state = 'funding', vendor_ref = $2, dest_amount = $3, quote = $4, updated_at = now()
      where id = $1
      returning id, state, payload_hash, source_currency, source_amount, dest_currency, dest_amount, quote`,
    [txId, result.ticketId, destMinor, JSON.stringify(quoteSnapshot)],
  );
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, $2, $3, 'convert.initiated', $4)`,
    [orgId, initiatedByPersonId ? "user" : "system", initiatedByPersonId,
     JSON.stringify({ txId, vendorRef: result.ticketId, from, to, amount: input.amount })],
  );
  return receiptFrom(upd.rows[0]!);
}
