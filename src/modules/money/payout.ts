/**
 * Payout (PRD-11) — money-out to a registered beneficiary, PIX rail today. Runs on the shared
 * PRD-07 §2 two-phase loop (moneyLoop.ts:runMoneyLoop) — reservation under the per-org money
 * lock, Avenia call with no lock held, leave-'created' on a lost response (a payout ticket
 * auto-executes once POSTed). Settle posts the 2-leg source-currency debit in ticketApply.ts.
 *
 * Money-out extras over Convert, gated BEFORE any reservation: the beneficiary must belong to
 * the org, be on a payable rail, and be active; and the 24h post-recovery hold (PRD-07 v5).
 */
import { createHash } from "node:crypto";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount } from "../../money/money.js";
import { moneyOutHoldActive } from "../access/recoveryHold.js";
import { getPayoutBeneficiary, ensureAveniaBeneficiary } from "../beneficiaries/beneficiaries.service.js";
import { mapVendorFees, runMoneyLoop, type MappedFee, type MoneyTxRow } from "./moneyLoop.js";
import type { PayoutRail, SubAccountCreator } from "../providers/avenia/avenia.client.js";

export type PayoutClient = PayoutRail & SubAccountCreator;

// v1: BRLA held balance -> BRL PIX only (quote leg verified live 2026-07-14; USDT->PIX is
// quote-confirmed but ships with FX-payout pricing, PRD-09).
const SOURCE_CURRENCY = "BRLA" as const;

export interface PayoutReceipt {
  id: string;
  state: string;
  beneficiaryId: string | null;
  sourceCurrency: string;
  sourceAmount: number; // minor units (centavos BRLA)
  destAmount: number | null; // centavos BRL actually sent, from ticket actuals
  fees: MappedFee[];
}

function receiptFrom(row: MoneyTxRow): PayoutReceipt {
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

  return runMoneyLoop({
    orgId,
    initiatedByPersonId,
    idemKey: input.idemKey,
    type: "payout",
    // beneficiary_id is part of the payload: same amount to a DIFFERENT payee must never replay.
    hash: createHash("sha256").update(`${orgId}:payout:${input.beneficiaryId}:${input.amount}`).digest("hex"),
    sourceCurrency: SOURCE_CURRENCY,
    sourceAmount: amountMinor,
    destCurrency: "BRL",
    beneficiaryId: input.beneficiaryId,
    client,
    phase2: async (subAccountId) => {
      const aveniaBeneficiaryId = await ensureAveniaBeneficiary(orgId, beneficiary, subAccountId, client);
      return client.createPixPayout({
        subAccountId,
        inputCurrency: SOURCE_CURRENCY,
        inputAmount: input.amount,
        beneficiaryBrlBankAccountId: aveniaBeneficiaryId,
        externalId: input.idemKey,
      });
    },
    auditEvent: "payout.initiated",
    auditPayload: { beneficiaryId: input.beneficiaryId, amount: input.amount },
    receipt: receiptFrom,
    pendingCode: "payout_pending_reconcile",
    conflictCode: "payout_conflict_retry",
  });
}
