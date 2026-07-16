/**
 * Payout (PRD-11) — money-out to a registered beneficiary over one of the PAYOUT_RAILS.
 * Runs on the shared PRD-07 §2 two-phase loop (moneyLoop.ts:runMoneyLoop) — reservation under
 * the per-org money lock, Avenia call with no lock held, leave-'created' on a lost response
 * (a payout ticket auto-executes once POSTed). Settle posts the 2-leg source-currency debit
 * in ticketApply.ts, currency-agnostic by construction.
 *
 * Rails (vendor surface verified 2026-07-15): pix = BRLA -> BRL PIX; ach/fedwire = USDT -> USD
 * ACH/WIRE (bank payee forwarded to Avenia's /usd/ endpoint); crypto = the payee's stablecoin
 * to their external wallet (address inline in the ticket, no registration). EUR/SEPA is
 * deferred until customers can hold EURC; swift/sepa payees are capture-only.
 *
 * Money-out extras over Convert, gated BEFORE any reservation: the beneficiary must belong to
 * the org, be on a payable rail, and be active; and the 24h post-recovery hold (PRD-07 v5).
 */
import { createHash } from "node:crypto";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, type Currency } from "../../money/money.js";
import { moneyOutHoldActive } from "../access/recoveryHold.js";
import { getPayoutBeneficiary, ensureAveniaBeneficiary, type PayoutBeneficiary } from "../beneficiaries/beneficiaries.service.js";
import { mapVendorFees, runMoneyLoop, type MappedFee, type MoneyTxRow } from "./moneyLoop.js";
import type { PayoutRail, SubAccountCreator, AveniaSwapResult } from "../providers/avenia/avenia.client.js";

export type PayoutClient = PayoutRail & SubAccountCreator;

/** Our crypto network labels (rails.ts CRYPTO_NETWORKS, mirrored in the payee form) -> Avenia
 *  chain enums. A payee whose label isn't here is not payable (defensive: labels are enforced
 *  at capture, so this only gates legacy/hand-edited rows). */
const AVENIA_CHAINS: Record<string, string> = {
  "TRON (TRC-20)": "TRON",
  "Polygon": "POLYGON",
  "Ethereum (ERC-20)": "ETHEREUM",
  "Base": "BASE",
};

interface PayoutRailSpec {
  sourceCurrency: (b: PayoutBeneficiary) => Currency | null; // null = payee not payable as stored
  destCurrency: (b: PayoutBeneficiary) => Currency;
  /** Pre-reservation completeness check — throws 422 before any hold is taken. */
  gate?: (b: PayoutBeneficiary) => void;
  phase2: (
    client: PayoutClient,
    subAccountId: string,
    input: { orgId: string; amount: string; idemKey: string },
    beneficiary: PayoutBeneficiary,
  ) => Promise<AveniaSwapResult>;
}

// In-code map on purpose: each rail IS a client call — a DB row can't add one. Per-org rail
// enablement, if ever needed, is a feature-flag column, not this table.
const PAYOUT_RAILS: Record<string, PayoutRailSpec> = {
  pix: {
    sourceCurrency: () => "BRLA",
    destCurrency: () => "BRL",
    phase2: async (client, subAccountId, input, beneficiary) => {
      const aveniaBeneficiaryId = await ensureAveniaBeneficiary(input.orgId, beneficiary, subAccountId, client);
      return client.createPixPayout({
        subAccountId,
        inputCurrency: "BRLA",
        inputAmount: input.amount,
        beneficiaryBrlBankAccountId: aveniaBeneficiaryId,
        externalId: input.idemKey,
      });
    },
  },
  ach: usdRail("ACH"),
  fedwire: usdRail("WIRE"),
  crypto: {
    // Funded from the payee's own asset (USDT or USDC) — held balance in that coin required.
    sourceCurrency: (b) => (b.asset === "USDT" || b.asset === "USDC" ? b.asset : null),
    destCurrency: (b) => b.asset as Currency,
    phase2: (client, subAccountId, input, beneficiary) =>
      client.createCryptoPayout({
        subAccountId,
        currency: beneficiary.asset!,
        inputAmount: input.amount,
        chain: AVENIA_CHAINS[beneficiary.network ?? ""]!,
        walletAddress: beneficiary.destination!.walletAddress!,
        ...(beneficiary.destination?.memoTag ? { walletMemo: beneficiary.destination.memoTag } : {}),
        externalId: input.idemKey,
      }),
  },
};

function usdRail(method: "ACH" | "WIRE"): PayoutRailSpec {
  return {
    sourceCurrency: () => "USDT", // the held coin funding USD payouts (USDC when customers hold it)
    destCurrency: () => "USD",
    gate: (b) => {
      if (b.avenia_beneficiary_id) return; // already registered at Avenia — fields no longer matter
      const d = b.destination ?? {};
      // Pre-2026-07-15 USD payees miss bankName/address; reject before any reservation.
      if (!d.accountNumber || !d.routingNumber || !d.bankName || !d.streetLine1 || !d.city || !d.state || !d.postalCode) {
        throw new HttpError("beneficiary_incomplete", 422);
      }
    },
    phase2: async (client, subAccountId, input, beneficiary) => {
      const aveniaBeneficiaryId = await ensureAveniaBeneficiary(input.orgId, beneficiary, subAccountId, client);
      return client.createUsdPayout({
        subAccountId,
        inputCurrency: "USDT",
        inputAmount: input.amount,
        method,
        beneficiaryUsdBankAccountId: aveniaBeneficiaryId,
        externalId: input.idemKey,
      });
    },
  };
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

  // Money-out gates that don't apply to Convert: destination + post-recovery hold.
  const beneficiary = await getPayoutBeneficiary(orgId, input.beneficiaryId);
  if (!beneficiary) throw new HttpError("beneficiary_not_found", 404);
  const rail = PAYOUT_RAILS[beneficiary.rail ?? ""];
  if (!rail) throw new HttpError("unsupported_rail", 422); // swift/sepa payees are capture-only
  const sourceCurrency = rail.sourceCurrency(beneficiary);
  if (!sourceCurrency || (beneficiary.rail === "crypto" && !AVENIA_CHAINS[beneficiary.network ?? ""])) {
    throw new HttpError("unsupported_rail", 422);
  }
  if (beneficiary.status !== "active") throw new HttpError("beneficiary_disabled", 422);
  rail.gate?.(beneficiary);
  if (await moneyOutHoldActive(orgId)) throw new HttpError("money_out_held", 403);

  const amountMinor = parseCustomerAmount(input.amount, sourceCurrency);
  if (amountMinor === null) throw new HttpError("invalid_amount", 422);

  return runMoneyLoop({
    orgId,
    initiatedByPersonId,
    idemKey: input.idemKey,
    type: "payout",
    // beneficiary_id is part of the payload: same amount to a DIFFERENT payee must never replay.
    hash: createHash("sha256").update(`${orgId}:payout:${input.beneficiaryId}:${input.amount}`).digest("hex"),
    sourceCurrency,
    sourceAmount: amountMinor,
    destCurrency: rail.destCurrency(beneficiary),
    beneficiaryId: input.beneficiaryId,
    client,
    phase2: (subAccountId) => rail.phase2(client, subAccountId, { orgId, amount: input.amount, idemKey: input.idemKey }, beneficiary),
    auditEvent: "payout.initiated",
    auditPayload: { beneficiaryId: input.beneficiaryId, amount: input.amount },
    receipt: receiptFrom,
    pendingCode: "payout_pending_reconcile",
    conflictCode: "payout_conflict_retry",
  });
}
