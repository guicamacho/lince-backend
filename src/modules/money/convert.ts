/**
 * Convert — standalone currency swap (PRD-10). The customer reshapes their OWN held balance
 * from one currency to another (BRL<->USD, i.e. BRLA<->USDT) and keeps the result. Runs on
 * the shared PRD-07 §2 two-phase loop (moneyLoop.ts:runMoneyLoop) — reservation under the
 * per-org money lock, Avenia call with no lock held, leave-'created' on a lost response.
 * Settle posts the 4-leg ledger entry in ticketApply.ts.
 *
 * ponytail: the under-lock active re-check (B14) rides on the /app gate's active-membership
 * check today; wire an explicit access_status re-check when that column/framework lands.
 */
import { createHash } from "node:crypto";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, type Currency } from "../../money/money.js";
import { mapVendorFees, runMoneyLoop, type MappedFee, type MoneyTxRow } from "./moneyLoop.js";
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

export interface ConvertReceipt {
  id: string;
  state: string;
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: number; // minor units of the source currency
  destAmount: number | null;
  fees: MappedFee[];
}

function receiptFrom(row: MoneyTxRow): ConvertReceipt {
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

  return runMoneyLoop({
    orgId,
    initiatedByPersonId,
    idemKey: input.idemKey,
    type: "convert_and_send",
    hash: createHash("sha256").update(`${orgId}:convert:${from}:${to}:${input.amount}`).digest("hex"),
    sourceCurrency: from,
    sourceAmount: amountMinor,
    destCurrency: to,
    beneficiaryId: null,
    client,
    phase2: (subAccountId) =>
      client.createSwap({
        subAccountId,
        inputCurrency: from,
        outputCurrency: to,
        inputAmount: input.amount,
        externalId: input.idemKey,
      }),
    auditEvent: "convert.initiated",
    auditPayload: { from, to, amount: input.amount },
    receipt: receiptFrom,
    pendingCode: "convert_pending_reconcile",
    conflictCode: "convert_conflict_retry",
  });
}
