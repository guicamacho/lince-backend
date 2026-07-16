/**
 * Cross-cutting money-path code shared by deposits, convert, and payouts:
 * the in-flight ticket reconciler, the vendor-fee display mapper, and the
 * org transaction list. (The shared two-phase reservation loop for money-out
 * lands here as runMoneyLoop — extracted from convert/payout.)
 */
import { pool, withTransaction } from "../../db/pool.js";
import { vendorMinor, type Currency } from "../../money/money.js";
import { applyTicketStatus, APPLY_ROW_COLUMNS, type ApplyRow } from "./ticketApply.js";
import type { TicketReader } from "../providers/avenia/avenia.client.js";

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

/**
 * Poll backstop for ALL in-flight avenia tickets — deposits, converts, and payouts (G19 gap
 * tolerance): tickets whose webhooks were missed — or never delivered at all, as in local dev
 * where the webhook registration points at the deployed endpoint — get their status pulled and
 * applied through the SAME monotonic guard the webhook handler uses. Only rows quiet for
 * `quietSeconds` are polled, so webhooks always win when they're flowing; per-run cap keeps
 * Avenia calls bounded (rate limits unconfirmed — Avenia question #10).
 */
export async function reconcileInFlightTickets(rail: TicketReader, quietSeconds = 45, limit = 10): Promise<number> {
  // Includes 'created' rows with a NULL vendor_ref: these are crash-orphans (ticket live at
  // Avenia, id never persisted). We recover them by externalId (= idem_key) below.
  const { rows } = await pool.query<{ id: string; vendor_ref: string | null; idem_key: string; subaccount_id: string | null; dest_currency: string | null }>(
    `select t.id, t.vendor_ref, t.idem_key::text as idem_key, a.subaccount_id, t.dest_currency
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
    if (!ticket) {
      // No ticket at Avenia. A null-vendor_ref 'created' row never got one (create never reached
      // Avenia), so nothing executed — release it, or a money-out reservation would hold the
      // customer's balance forever. A vendor_ref row is a transient lookup miss: keep polling.
      if (!r.vendor_ref) {
        await pool.query(
          `update org_transactions set state = 'failed', error = $2, updated_at = now()
             where id = $1 and state = 'created'`,
          [r.id, JSON.stringify({ stage: "reconcile", message: "no ticket at avenia (externalId not found)" })],
        );
      }
      continue;
    }
    await withTransaction(async (c) => {
      const locked = await c.query<ApplyRow>(
        `select ${APPLY_ROW_COLUMNS} from org_transactions where id = $1 for update`,
        [r.id],
      );
      if (!locked.rows[0]) return;
      // Backfill a recovered orphan's vendor_ref + dest_amount before applying status, so the
      // settle posting has the credited amount.
      if (!r.vendor_ref) {
        // dest currency is per-row: BRLA for a deposit, the target coin for a convert orphan.
        const dest = ticket.outputAmount ? vendorMinor(ticket.outputAmount, (r.dest_currency ?? "BRLA") as Currency) : null;
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
    `select t.id, t.type, t.state, t.source_currency, t.source_amount, t.dest_currency, t.dest_amount,
            t.quote, t.vendor_ref, t.created_at, b.label as beneficiary_label
       from org_transactions t
       left join avenia_beneficiaries b on b.id = t.beneficiary_id
      where t.org_id = $1 order by t.created_at desc limit 100`,
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
      beneficiaryLabel: r.beneficiary_label ?? null,
      createdAt: r.created_at,
      vendorRef: r.vendor_ref,
      quote: { basePrice: quote.basePrice, pairName: quote.pairName },
    };
  });
}
