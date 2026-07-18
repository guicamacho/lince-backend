/**
 * Cross-cutting money-path code shared by deposits, convert, and payouts:
 * the in-flight ticket reconciler, the vendor-fee display mapper, and the
 * org transaction list. (The shared two-phase reservation loop for money-out
 * lands here as runMoneyLoop — extracted from convert/payout.)
 */
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { vendorMinor, type Currency } from "../../money/money.js";
import { acquireOrgMoneyLock } from "../../db/lockKeys.js";
import { moneyOutHoldActive } from "../access/recoveryHold.js";
import { ensureAveniaSubaccount } from "../onboarding/aveniaProvisioning.js";
import { applyTicketStatus, APPLY_ROW_COLUMNS, type ApplyRow } from "./ticketApply.js";
import type { TicketReader, SubAccountCreator, AveniaSwapResult } from "../providers/avenia/avenia.client.js";

/** Superset row both money-out flows project their receipts from. */
export interface MoneyTxRow {
  id: string;
  state: string;
  payload_hash: string | null;
  beneficiary_id: string | null;
  source_currency: string;
  source_amount: string;
  dest_currency: string;
  dest_amount: string | null;
  quote: Record<string, unknown> | null;
}

const TX_COLUMNS = "id, state, payload_hash, beneficiary_id, source_currency, source_amount, dest_currency, dest_amount, quote";

/**
 * The PRD-07 §2 two-phase money-out loop shared by Convert and Payouts. The parts that must
 * never diverge are fixed here:
 *
 *   Phase 1 (under the per-org advisory money lock): reserve — insert a 'created' row and confirm
 *     settled(src) - Σ(in-flight outbound reservations in src) >= 0, computed in ONE snapshot
 *     query so a concurrent settle can't read-skew it. Overcommit rolls the reservation back.
 *     Replay of the same (org, idemKey) returns the existing row; a different payload is a 409.
 *   Phase 2 (NO lock held): the rail's Avenia call via the `phase2` closure. On ANY error the
 *     row stays 'created' — a ticket auto-executes the instant it is POSTed, so marking 'failed'
 *     on a lost response would strand executed money (the reconciler skips 'failed' and the PAID
 *     webhook can't match a null vendor_ref). reconcileInFlightTickets settles or releases it.
 *
 * MONEY-OUT GATES live here too (Cluster 2) so no caller can forget one:
 *   - the 24h post-recovery hold blocks NEW reservations (403 money_out_held); replays of an
 *     already-claimed intent still return their receipt — the money may already have moved,
 *     and idempotent reads must never fail;
 *   - a Phase-2 pre-flight re-checks orgs.access_status right before the vendor call: an
 *     admin suspend/block landing between the route gate and Phase 2 must not send money.
 *     No vendor call has happened at that point, so failing the row is SAFE (it releases
 *     the reservation; the leave-'created' rule applies only once the call is attempted);
 *   - the future limits/velocity check (PRD-04 §13.2) slots in next to the hold check.
 *
 * Settle stays in ticketApply.ts. Deposits do NOT ride this loop on purpose: a PIX-in charge
 * takes no lock, reserves nothing, and safely marks 'failed' on error.
 */
export async function runMoneyLoop<R>(args: {
  orgId: string;
  initiatedByPersonId: string | null;
  idemKey: string;
  type: "convert_and_send" | "payout";
  hash: string; // sha256 of the caller's canonical payload — binds idemKey to the request
  sourceCurrency: Currency;
  sourceAmount: bigint;
  destCurrency: Currency; // used for vendorMinor(outputAmount) on the funding update
  beneficiaryId: string | null;
  client: SubAccountCreator; // for the org subaccount; phase2 closes over the full rail client
  phase2: (subAccountId: string) => Promise<AveniaSwapResult>;
  auditEvent: string;
  auditPayload: Record<string, unknown>;
  receipt: (row: MoneyTxRow) => R;
  pendingCode: string; // *_pending_reconcile
  conflictCode: string; // *_conflict_retry
}): Promise<R> {
  // PHASE 1 — reserve under the per-org money lock (advisory xact lock auto-releases on commit).
  const reservation = await withTransaction(async (c) => {
    await acquireOrgMoneyLock(c, args.orgId);
    const claim = await c.query<{ id: string }>(
      `insert into org_transactions
         (org_id, type, state, initiated_by_user_id, beneficiary_id, source_currency, source_amount,
          dest_currency, provider_code, idem_key, payload_hash)
       values ($1, $2, 'created', $3, $4, $5, $6, $7, 'avenia', $8, $9)
       on conflict (org_id, idem_key) do nothing
       returning id`,
      [args.orgId, args.type, args.initiatedByPersonId, args.beneficiaryId,
       args.sourceCurrency, args.sourceAmount, args.destCurrency, args.idemKey, args.hash],
    );
    if (!claim.rowCount) {
      // Replay: return the existing reservation, no new hold, no balance re-check —
      // and no money-out gates: the intent may already have executed, and an
      // idempotent read must never fail because a hold started afterwards.
      const { rows } = await c.query<MoneyTxRow>(
        `select ${TX_COLUMNS} from org_transactions where org_id = $1 and idem_key = $2`,
        [args.orgId, args.idemKey],
      );
      const existing = rows[0];
      if (!existing) throw new HttpError(args.conflictCode, 409);
      if (existing.payload_hash !== args.hash) throw new HttpError("idem_key_payload_mismatch", 409);
      return { replay: true as const, row: existing };
    }
    // Post-recovery hold (PRD-07 §3.5): NEW money-out is blocked for 24h after an
    // account recovery. Checked on the tx client; the throw rolls the reservation back.
    if (await moneyOutHoldActive(args.orgId, new Date(), c)) throw new HttpError("money_out_held", 403);
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
      [args.orgId, args.sourceCurrency],
    );
    if (BigInt(rows[0]!.available) < 0n) throw new HttpError("insufficient_balance", 422);
    return { replay: false as const, txId: claim.rows[0]!.id };
  });
  if (reservation.replay) return args.receipt(reservation.row);
  const txId = reservation.txId;

  // PHASE 2 pre-flight — access_status re-check (PRD-07 §2): an admin suspend/block that
  // landed after the route gate must stop here. Safe to fail the row: no vendor call yet,
  // so nothing can have executed, and 'failed' releases the reservation.
  const access = await pool.query<{ access_status: string }>(
    `select access_status from orgs where id = $1`,
    [args.orgId],
  );
  if (access.rows[0]?.access_status !== "active") {
    await pool.query(
      `update org_transactions set state = 'failed', error = $2, updated_at = now()
        where id = $1 and state = 'created'`,
      [txId, JSON.stringify({ stage: "access_recheck", accessStatus: access.rows[0]?.access_status ?? "missing" })],
    );
    throw new HttpError("org_access_restricted", 403);
  }

  // PHASE 2 — no lock held: subaccount, then the rail's Avenia call.
  let result;
  try {
    const sub = await ensureAveniaSubaccount(args.orgId, args.client);
    if (!sub) throw new Error("no subaccount");
    result = await args.phase2(sub);
  } catch (e) {
    // Do NOT mark 'failed' here — see the module doc. Record the error only.
    await pool.query(
      `update org_transactions set error = $2, updated_at = now() where id = $1 and state = 'created'`,
      [txId, JSON.stringify({ stage: "create", message: e instanceof Error ? e.message : String(e) })],
    );
    throw e instanceof HttpError ? e : new HttpError(args.pendingCode, 502);
  }

  const destMinor = vendorMinor(result.quote.outputAmount, args.destCurrency);
  const quoteSnapshot = {
    ticketStatus: "UNPAID",
    basePrice: result.quote.basePrice,
    pairName: result.quote.pairName,
    inputAmount: result.quote.inputAmount,
    outputAmount: result.quote.outputAmount,
    appliedFees: result.quote.appliedFees,
  };
  const upd = await pool.query<MoneyTxRow>(
    `update org_transactions
        set state = 'funding', vendor_ref = $2, dest_amount = $3, quote = $4, updated_at = now()
      where id = $1
      returning ${TX_COLUMNS}`,
    [txId, result.ticketId, destMinor, JSON.stringify(quoteSnapshot)],
  );
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, $2, $3, $4, $5)`,
    [args.orgId, args.initiatedByPersonId ? "user" : "system", args.initiatedByPersonId,
     args.auditEvent, JSON.stringify({ txId, vendorRef: result.ticketId, ...args.auditPayload })],
  );
  return args.receipt(upd.rows[0]!);
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
