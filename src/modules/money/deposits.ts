/**
 * Customer PIX deposits (F-Depositar, first real org_transactions producer).
 *
 * Flow: claim an org_transactions row (idempotency), quote+ticket on Avenia scoped to the
 * org's subaccount (proven to credit the subaccount directly — no fund-shifting), fill the
 * row with the ticket's ACTUAL quote snapshot. Webhook TICKET events drive state from there
 * (processor.ts aveniaHandler).
 *
 * PRD-07 §2 pattern 5 (idempotency payload binding) lives here: the claim carries
 * payload_hash = sha256 of the canonical request; a replay with the SAME (org, idem_key)
 * and SAME hash returns the existing row, a DIFFERENT hash is a 409 — never a second ticket.
 * The Avenia call runs with NO db lock held (lock-ordering invariant).
 *
 * ponytail: fee_amount/fee_currency columns stay null — fees are itemized (multi-currency)
 * in quote.appliedFees; a single blended fee column misrepresents the no-spread model.
 * ponytail: ledger postings on PAID are the postings WP (needs per-org ledger accounts);
 * until then settled state lives on org_transactions only.
 */
import { createHash } from "node:crypto";
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, vendorMinor } from "../../money/money.js";
import { ensureAveniaSubaccount } from "../onboarding/aveniaProvisioning.js";
import { mapVendorFees } from "./moneyLoop.js";
import type { DepositRail, SubAccountCreator, AccountInfoReader } from "../providers/avenia/avenia.client.js";

export type DepositClient = DepositRail & SubAccountCreator & AccountInfoReader;

export interface DepositReceipt {
  id: string;
  state: string;
  brCode: string | null;
  expiration: string | null;
  sourceAmount: number; // minor units (centavos)
  destAmount: number | null;
  fees: Array<{ label: string; amount: number; currency: string; rebatable: boolean }>;
}

function canonicalHash(orgId: string, amountBrl: string): string {
  return createHash("sha256").update(`${orgId}:deposit:${amountBrl}:BRL:PIX:BRLA:INTERNAL`).digest("hex");
}

interface TxRow {
  id: string;
  state: string;
  payload_hash: string | null;
  source_amount: string;
  dest_amount: string | null;
  quote: Record<string, unknown> | null;
}

function receiptFrom(row: TxRow): DepositReceipt {
  const quote = (row.quote ?? {}) as {
    brCode?: string;
    expiration?: string;
    appliedFees?: unknown;
  };
  return {
    id: row.id,
    state: row.state,
    brCode: quote.brCode ?? null,
    expiration: quote.expiration ?? null,
    sourceAmount: Number(row.source_amount),
    destAmount: row.dest_amount === null ? null : Number(row.dest_amount),
    fees: mapVendorFees(quote.appliedFees),
  };
}

export async function createDeposit(
  orgId: string,
  initiatedByPersonId: string | null,
  input: { amountBrl: string; idemKey: string },
  client: DepositClient | null,
): Promise<DepositReceipt> {
  if (!client) throw new HttpError("avenia_unavailable", 503);
  // Strict customer-input validation BEFORE any parsing/DB work — malformed amounts (1e9,
  // empty, >2dp, out-of-range) become a clean 422, never an uncaught throw / int8 overflow.
  const amountMinor = parseCustomerAmount(input.amountBrl, "BRL");
  if (amountMinor === null) throw new HttpError("invalid_amount", 422);
  const hash = canonicalHash(orgId, input.amountBrl);

  // Idempotency claim (pattern 5): first inserter owns the Avenia call.
  const claim = await pool.query<TxRow>(
    `insert into org_transactions
       (org_id, type, state, initiated_by_user_id, source_currency, source_amount,
        dest_currency, provider_code, idem_key, payload_hash)
     values ($1, 'deposit', 'created', $2, 'BRL', $3, 'BRLA', 'avenia', $4, $5)
     on conflict (org_id, idem_key) do nothing
     returning id, state, payload_hash, source_amount, dest_amount, quote`,
    [orgId, initiatedByPersonId, amountMinor, input.idemKey, hash],
  );
  if (!claim.rowCount) {
    const { rows } = await pool.query<TxRow>(
      `select id, state, payload_hash, source_amount, dest_amount, quote
         from org_transactions where org_id = $1 and idem_key = $2`,
      [orgId, input.idemKey],
    );
    const existing = rows[0];
    if (!existing) throw new HttpError("deposit_conflict_retry", 409);
    if (existing.payload_hash !== hash) throw new HttpError("idem_key_payload_mismatch", 409);
    return receiptFrom(existing); // same request replayed — same ticket, no double-create
  }
  const txId = claim.rows[0]!.id;

  // Own the claim: subaccount (lazily healed for pre-provisioning orgs), then quote+ticket.
  // externalId = idem_key makes the Avenia ticket idempotent: a retry won't duplicate it, and
  // the reconciler can recover the ticket by externalId if we crash before persisting its id.
  let result;
  try {
    const sub = await ensureAveniaSubaccount(orgId, client);
    if (!sub) throw new Error("no subaccount");
    result = await client.createPixDeposit({ subAccountId: sub, amountBrl: input.amountBrl, externalId: input.idemKey });
  } catch (e) {
    await pool.query(
      `update org_transactions set state = 'failed', error = $2, updated_at = now() where id = $1`,
      [txId, JSON.stringify({ stage: "create", message: e instanceof Error ? e.message : String(e) })],
    );
    throw e instanceof HttpError ? e : new HttpError("deposit_unavailable", 502);
  }

  // vendorMinor is non-throwing (rounds Avenia's decimals to our dp): the post-ticket UPDATE
  // can no longer throw and strand the row with the ticket already live at Avenia.
  const destMinor = vendorMinor(result.quote.outputAmount, "BRLA");
  const quoteSnapshot = {
    ticketStatus: "UNPAID",
    brCode: result.brCode,
    expiration: result.expiration,
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
      returning id, state, payload_hash, source_amount, dest_amount, quote`,
    [txId, result.ticketId, destMinor, JSON.stringify(quoteSnapshot)],
  );
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, $2, $3, 'deposit.initiated', $4)`,
    [orgId, initiatedByPersonId ? "user" : "system", initiatedByPersonId,
     JSON.stringify({ txId, vendorRef: result.ticketId, amountBrl: input.amountBrl })],
  );
  return receiptFrom(upd.rows[0]!);
}
