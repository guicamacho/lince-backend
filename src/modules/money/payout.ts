/**
 * PIX payout (PRD-11) — money-out to a registered beneficiary. The customer's held BRLA is
 * paid out as BRL over PIX to a payee from the address book. Same PRD-07 §2 money-loop as
 * Convert (convert.ts is the reference):
 *
 *   Phase 1 (under the per-org advisory money lock): reserve — insert a 'created' row and confirm
 *     settled(src) - Σ(in-flight outbound reservations in src) >= 0 in ONE snapshot query.
 *     Convert and payout reservations share the same pool, so they contend correctly.
 *   Phase 2 (NO lock held): forward the payee to Avenia if never forwarded (lazy, first use),
 *     then quote+ticket. A payout ticket AUTO-EXECUTES once POSTed — on any Phase-2 error the
 *     row stays 'created' (never 'failed') so the reconciler can settle by externalId or
 *     release the hold (the convert money-loss rule).
 *
 * Money-out extras over Convert: the beneficiary must belong to the org, be PIX, and be active;
 * and the 24h post-recovery hold (PRD-07 v5) is consulted before any reservation.
 * Settle posts the 2-leg ledger entry in ticketApply.ts (payout-settle:{txId}).
 */
import { createHash } from "node:crypto";
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, vendorMinor } from "../../money/money.js";
import { acquireOrgMoneyLock } from "../../db/lockKeys.js";
import { moneyOutHoldActive } from "../access/recoveryHold.js";
import { ensureAveniaSubaccount } from "../onboarding/aveniaProvisioning.js";
import { getPayoutBeneficiary, ensureAveniaBeneficiary } from "../beneficiaries/beneficiaries.service.js";
import { mapVendorFees, type MappedFee } from "./moneyLoop.js";
import type { PayoutRail, SubAccountCreator } from "../providers/avenia/avenia.client.js";

export type PayoutClient = PayoutRail & SubAccountCreator;

// v1: BRLA held balance -> BRL PIX only (quote leg verified live 2026-07-14; USDT->PIX is
// quote-confirmed but ships with FX-payout pricing, PRD-09).
const SOURCE_CURRENCY = "BRLA" as const;

function canonicalHash(orgId: string, beneficiaryId: string, amount: string): string {
  // beneficiary_id is part of the payload: same amount to a DIFFERENT payee must never replay.
  return createHash("sha256").update(`${orgId}:payout:${beneficiaryId}:${amount}`).digest("hex");
}

export interface PayoutReceipt {
  id: string;
  state: string;
  beneficiaryId: string | null;
  sourceCurrency: string;
  sourceAmount: number; // minor units (centavos BRLA)
  destAmount: number | null; // centavos BRL actually sent, from ticket actuals
  fees: MappedFee[];
}

interface TxRow {
  id: string;
  state: string;
  payload_hash: string | null;
  beneficiary_id: string | null;
  source_currency: string;
  source_amount: string;
  dest_amount: string | null;
  quote: Record<string, unknown> | null;
}

const TX_COLUMNS = "id, state, payload_hash, beneficiary_id, source_currency, source_amount, dest_amount, quote";

function receiptFrom(row: TxRow): PayoutReceipt {
  const quote = (row.quote ?? {}) as { appliedFees?: unknown };
  return {
    id: row.id,
    state: row.state,
    beneficiaryId: row.beneficiary_id,
    sourceCurrency: row.source_currency,
    sourceAmount: Number(row.source_amount),
    destAmount: row.dest_amount === null ? null : Number(row.dest_amount),
    fees: mapVendorFees(quote.appliedFees),
  };
}

export async function createPayout(
  orgId: string,
  initiatedByPersonId: string | null,
  input: { beneficiaryId: string; amount: string; idemKey: string },
  client: PayoutClient | null,
): Promise<PayoutReceipt> {
  if (!client) throw new HttpError("avenia_unavailable", 503);
  const amountMinor = parseCustomerAmount(input.amount, SOURCE_CURRENCY);
  if (amountMinor === null) throw new HttpError("invalid_amount", 422);

  // Money-out gates that don't apply to Convert: destination + post-recovery hold.
  const beneficiary = await getPayoutBeneficiary(orgId, input.beneficiaryId);
  if (!beneficiary) throw new HttpError("beneficiary_not_found", 404);
  if (beneficiary.rail !== "pix") throw new HttpError("unsupported_rail", 422);
  if (beneficiary.status !== "active") throw new HttpError("beneficiary_disabled", 422);
  if (await moneyOutHoldActive(orgId)) throw new HttpError("money_out_held", 403);

  const hash = canonicalHash(orgId, input.beneficiaryId, input.amount);

  // PHASE 1 — reserve under the per-org money lock (shared with Convert: one balance, one lock).
  const reservation = await withTransaction(async (c) => {
    await acquireOrgMoneyLock(c, orgId);
    const claim = await c.query<{ id: string }>(
      `insert into org_transactions
         (org_id, type, state, initiated_by_user_id, beneficiary_id, source_currency, source_amount,
          dest_currency, provider_code, idem_key, payload_hash)
       values ($1, 'payout', 'created', $2, $3, $4, $5, 'BRL', 'avenia', $6, $7)
       on conflict (org_id, idem_key) do nothing
       returning id`,
      [orgId, initiatedByPersonId, input.beneficiaryId, SOURCE_CURRENCY, amountMinor, input.idemKey, hash],
    );
    if (!claim.rowCount) {
      // Replay: return the existing reservation, no new hold, no balance re-check.
      const { rows } = await c.query<TxRow>(
        `select ${TX_COLUMNS} from org_transactions where org_id = $1 and idem_key = $2`,
        [orgId, input.idemKey],
      );
      const existing = rows[0];
      if (!existing) throw new HttpError("payout_conflict_retry", 409);
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
      [orgId, SOURCE_CURRENCY],
    );
    if (BigInt(rows[0]!.available) < 0n) throw new HttpError("insufficient_balance", 422);
    return { replay: false as const, txId: claim.rows[0]!.id };
  });
  if (reservation.replay) return receiptFrom(reservation.row);
  const txId = reservation.txId;

  // PHASE 2 — no lock held: subaccount + beneficiary forwarding + Avenia quote+ticket.
  let result;
  try {
    const sub = await ensureAveniaSubaccount(orgId, client);
    if (!sub) throw new Error("no subaccount");
    const aveniaBeneficiaryId = await ensureAveniaBeneficiary(orgId, beneficiary, sub, client);
    result = await client.createPixPayout({
      subAccountId: sub,
      inputCurrency: SOURCE_CURRENCY,
      inputAmount: input.amount,
      beneficiaryBrlBankAccountId: aveniaBeneficiaryId,
      externalId: input.idemKey,
    });
  } catch (e) {
    // Do NOT mark 'failed' here. A payout ticket auto-executes the instant it is created, and
    // createPixPayout can throw AFTER the ticket POST reached Avenia (lost/truncated response).
    // Marking 'failed' would strand a transfer Avenia actually executed — customer money loss.
    // Leave the row 'created' so the reconciler settles the real ticket by externalId if it
    // exists, or releases the reservation when no ticket was ever created (deposits.ts).
    await pool.query(
      `update org_transactions set error = $2, updated_at = now() where id = $1 and state = 'created'`,
      [txId, JSON.stringify({ stage: "create", message: e instanceof Error ? e.message : String(e) })],
    );
    throw e instanceof HttpError ? e : new HttpError("payout_pending_reconcile", 502);
  }

  const destMinor = vendorMinor(result.quote.outputAmount, "BRL");
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
      returning ${TX_COLUMNS}`,
    [txId, result.ticketId, destMinor, JSON.stringify(quoteSnapshot)],
  );
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, $2, $3, 'payout.initiated', $4)`,
    [orgId, initiatedByPersonId ? "user" : "system", initiatedByPersonId,
     JSON.stringify({ txId, vendorRef: result.ticketId, beneficiaryId: input.beneficiaryId, amount: input.amount })],
  );
  return receiptFrom(upd.rows[0]!);
}
