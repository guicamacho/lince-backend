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
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { parseCustomerAmount, vendorMinor, type Currency } from "../../money/money.js";
import { ensureAveniaSubaccount } from "../onboarding/aveniaProvisioning.js";
import { applyTicketStatus, APPLY_ROW_COLUMNS, type ApplyRow } from "./ticketApply.js";
import type { DepositRail, SubAccountCreator, AccountInfoReader, TicketReader } from "../providers/avenia/avenia.client.js";

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

export interface MappedFee {
  label: string;
  amount: number;
  currency: string;
  rebatable: boolean;
}

/**
 * Map a stored quote's appliedFees (RAW vendor jsonb) to display fees. The whole shape is
 * untrusted, not just amount/currency: a non-array or a null element must degrade to nothing,
 * never throw — a single malformed fee on one snapshot once 500'd a whole transactions list,
 * and on the all-orgs admin view the blast radius is every row. vendorMinor hardens the
 * amount/currency scalars; this hardens the array/element shape.
 */
export function mapVendorFees(raw: unknown): MappedFee[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is { type?: unknown; amount?: unknown; currency?: unknown; rebatable?: unknown } =>
      typeof f === "object" && f !== null)
    .map((f) => ({
      label: String(f.type ?? "fee"),
      amount: Number(vendorMinor(String(f.amount ?? ""), (f.currency as Currency) ?? "BRL")),
      currency: String(f.currency ?? "BRL"),
      rebatable: f.rebatable === true,
    }));
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

/**
 * Poll backstop for in-flight deposits (G19 gap tolerance): tickets whose webhooks were
 * missed — or never delivered at all, as in local dev where the webhook registration
 * points at the deployed endpoint — get their status pulled and applied through the SAME
 * monotonic guard the webhook handler uses. Only rows quiet for `quietSeconds` are polled,
 * so webhooks always win when they're flowing; per-run cap keeps Avenia calls bounded
 * (rate limits unconfirmed — Avenia question #10).
 */
export async function reconcileInFlightDeposits(rail: TicketReader, quietSeconds = 45, limit = 10): Promise<number> {
  // Includes 'created' rows with a NULL vendor_ref: these are crash-orphans (ticket live at
  // Avenia, id never persisted). We recover them by externalId (= idem_key) below.
  const { rows } = await pool.query<{ id: string; vendor_ref: string | null; idem_key: string; subaccount_id: string | null }>(
    `select t.id, t.vendor_ref, t.idem_key::text as idem_key, a.subaccount_id
       from org_transactions t
       left join avenia_accounts a on a.org_id = t.org_id
      where t.provider_code = 'avenia'
        and t.state in ('created', 'funding', 'executing', 'on_hold')
        and t.updated_at < now() - make_interval(secs => $1)
      order by t.updated_at asc
      limit $2`,
    [quietSeconds, limit],
  );
  let applied = 0;
  for (const r of rows) {
    if (!r.subaccount_id) continue;
    let ticket;
    try {
      ticket = r.vendor_ref
        ? await rail.getTicket({ subAccountId: r.subaccount_id, ticketId: r.vendor_ref })
        : await rail.findTicketByExternalId({ subAccountId: r.subaccount_id, externalId: r.idem_key });
    } catch {
      continue; // transient Avenia error — next pass retries
    }
    if (!ticket) continue; // orphan with no ticket at Avenia (create never happened) — leave it
    await withTransaction(async (c) => {
      const locked = await c.query<ApplyRow>(
        `select ${APPLY_ROW_COLUMNS} from org_transactions where id = $1 for update`,
        [r.id],
      );
      if (!locked.rows[0]) return;
      // Backfill a recovered orphan's vendor_ref + dest_amount before applying status, so the
      // settle posting has the credited amount.
      if (!r.vendor_ref) {
        const dest = ticket.outputAmount ? vendorMinor(ticket.outputAmount, "BRLA") : null;
        await c.query(
          `update org_transactions set vendor_ref = $2, dest_amount = coalesce(dest_amount, $3), updated_at = now() where id = $1`,
          [r.id, ticket.id, dest],
        );
        locked.rows[0].dest_amount = (locked.rows[0].dest_amount ?? (dest === null ? null : String(dest)));
      }
      if ((await applyTicketStatus(c, locked.rows[0], ticket.status)) === "apply") applied++;
    });
  }
  return applied;
}

/** The frozen GET /app/transactions contract the F3 customer UI was built against. */
export async function listTransactionsForOrg(orgId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    `select id, type, state, source_currency, source_amount, dest_currency, dest_amount,
            quote, vendor_ref, created_at
       from org_transactions where org_id = $1 order by created_at desc limit 100`,
    [orgId],
  );
  return rows.map((r) => {
    const quote = (r.quote ?? {}) as {
      ticketStatus?: string;
      basePrice?: string;
      pairName?: string;
      appliedFees?: unknown;
    };
    return {
      id: r.id,
      type: r.type,
      state: r.state,
      status: quote.ticketStatus ?? "UNPAID",
      sourceCurrency: r.source_currency,
      sourceAmount: Number(r.source_amount),
      destCurrency: r.dest_currency,
      destAmount: r.dest_amount === null ? 0 : Number(r.dest_amount),
      fees: mapVendorFees(quote.appliedFees),
      rebate: null,
      beneficiaryLabel: null,
      createdAt: r.created_at,
      vendorRef: r.vendor_ref,
      quote: { basePrice: quote.basePrice, pairName: quote.pairName },
    };
  });
}
