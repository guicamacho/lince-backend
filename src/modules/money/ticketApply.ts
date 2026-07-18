/**
 * The ONE place an Avenia ticket status becomes an org_transactions state change —
 * and, on a deposit's settle, the ledger postings (same db transaction: state + postings
 * commit or roll back together; the monotonic guard makes it exactly-once even when the
 * webhook handler and the poll reconciler race, since both hold the row's FOR UPDATE).
 *
 * Deposit settle posting (Modelo A pass-through — Avenia custodies, Lince mirrors):
 *   +net BRLA  avenia:custody:BRLA          (vendor_asset — funds held at Avenia for customers)
 *   -net BRLA  org:{orgId}:BRLA             (customer_liability — what the customer sees)
 * Amounts come from the ticket's ACTUAL quote (dest_amount = outputAmount). No gross/fee
 * legs: the PIX-in fees are Avenia's and never touch Lince custody; they stay itemized in
 * the quote snapshot. Rebate/markup income legs land with the rebate WP.
 */
import type pg from "pg";
import { ticketTransitionAllowed, normalizeTicketStatus } from "../webhooks/ticketState.js";
import { ensureAccount, postBalancedTransactionOn } from "../ledger/ledger.service.js";
import { DuplicateLedgerPostError } from "../ledger/ledger.types.js";
import { enqueueNotification } from "../notifications/outbox.js";
import type { TicketState } from "../providers/provider.types.js";
import { fromMinor, vendorMinor, type Currency } from "../../money/money.js";

/** Avenia ticket status -> Lince org_transactions.state (deposit lifecycle). */
export const TICKET_TO_TX_STATE: Record<string, string> = {
  UNPAID: "funding",
  PROCESSING: "executing",
  ON_HOLD: "on_hold",
  PAID: "settled",
  FAILED: "failed",
  PARTIAL_FAILED: "failed",
  CANCELED: "cancelled",
};

export interface ApplyRow {
  id: string;
  org_id: string;
  type: string;
  source_currency: string | null;
  source_amount: string | null; // bigint comes back as string from pg
  dest_currency: string | null;
  dest_amount: string | null;
  quote: { ticketStatus?: string; appliedFees?: unknown } | null;
  created_at: Date | string;
}

export const APPLY_ROW_COLUMNS =
  "id, org_id, type, source_currency, source_amount, dest_currency, dest_amount, quote, created_at";

/** Apply a wire-format ticket status to a locked org_transactions row. Returns what happened. */
export async function applyTicketStatus(
  client: pg.PoolClient,
  tx: ApplyRow,
  wireStatus: string,
): Promise<"apply" | "ignore" | "reject"> {
  const incoming = normalizeTicketStatus(wireStatus);
  const current = (tx.quote?.ticketStatus ?? null) as TicketState | null;
  const decision = ticketTransitionAllowed(current, incoming);
  if (decision !== "apply") return decision;
  const nextState = TICKET_TO_TX_STATE[incoming] ?? "executing";
  await client.query(
    `update org_transactions
        set state = $2,
            quote = coalesce(quote, '{}'::jsonb) || jsonb_build_object('ticketStatus', $3::text),
            updated_at = now()
      where id = $1`,
    [tx.id, nextState, incoming],
  );
  if (nextState === "settled" && tx.type === "deposit" && tx.dest_amount && tx.dest_currency) {
    const currency = tx.dest_currency as Currency;
    const net = BigInt(tx.dest_amount);
    const custody = await ensureAccount(client, {
      key: `avenia:custody:${currency}`, type: "vendor_asset", currency,
    });
    const orgAccount = await ensureAccount(client, {
      key: `org:${tx.org_id}:${currency}`, type: "customer_liability", orgId: tx.org_id, currency,
    });
    try {
      await postBalancedTransactionOn(client, {
        description: `deposit settled (ticket actuals)`,
        orgTransactionId: tx.id,
        idempotencyKey: `deposit-settle:${tx.id}`, // exactly-once DB backstop
        postings: [
          { accountId: custody, amount: net, currency },
          { accountId: orgAccount, amount: -net, currency },
        ],
      });
    } catch (e) {
      // Already posted for this deposit (in-code guard regressed / raced): the state UPDATE
      // above is idempotent, so swallow and treat as applied — never double-credit the ledger.
      if (!(e instanceof DuplicateLedgerPostError)) throw e;
    }
  }

  // Convert settle (PRD-10): a swap reshapes existing custody — the customer gives up `in` of the
  // source currency and receives `out` of the destination. Four postings, balanced PER CURRENCY:
  //   src: -in custody (vendor holds less src)   +in  org liability (customer holds less src)
  //   dst: +out custody (vendor holds more dst)  -out org liability (customer holds more dst)
  // Amounts are the ticket ACTUALS (fees baked in, as with deposits). Markup income leg = PRD-09.
  if (
    nextState === "settled" && tx.type === "convert_and_send" &&
    tx.source_amount && tx.source_currency && tx.dest_amount && tx.dest_currency
  ) {
    const srcCcy = tx.source_currency as Currency;
    const dstCcy = tx.dest_currency as Currency;
    const inAmt = BigInt(tx.source_amount);
    const outAmt = BigInt(tx.dest_amount);
    const custodySrc = await ensureAccount(client, { key: `avenia:custody:${srcCcy}`, type: "vendor_asset", currency: srcCcy });
    const custodyDst = await ensureAccount(client, { key: `avenia:custody:${dstCcy}`, type: "vendor_asset", currency: dstCcy });
    const orgSrc = await ensureAccount(client, { key: `org:${tx.org_id}:${srcCcy}`, type: "customer_liability", orgId: tx.org_id, currency: srcCcy });
    const orgDst = await ensureAccount(client, { key: `org:${tx.org_id}:${dstCcy}`, type: "customer_liability", orgId: tx.org_id, currency: dstCcy });
    try {
      await postBalancedTransactionOn(client, {
        description: `convert settled (ticket actuals)`,
        orgTransactionId: tx.id,
        idempotencyKey: `convert-settle:${tx.id}`,
        postings: [
          { accountId: custodySrc, amount: -inAmt, currency: srcCcy },
          { accountId: orgSrc, amount: inAmt, currency: srcCcy },
          { accountId: custodyDst, amount: outAmt, currency: dstCcy },
          { accountId: orgDst, amount: -outAmt, currency: dstCcy },
        ],
      });
    } catch (e) {
      if (!(e instanceof DuplicateLedgerPostError)) throw e; // idempotent replay — never double-post
    }
  }

  // Payout settle (PRD-11): held source currency leaves custody entirely — the BRL lands at the
  // beneficiary's bank, outside our ledger. Two postings in the SOURCE currency for the full
  // reserved amount (the PIX-out fee is Avenia's, baked into the smaller BRL output and itemized
  // in the quote snapshot; dest_amount records the BRL actually sent, display-only).
  if (nextState === "settled" && tx.type === "payout" && tx.source_amount && tx.source_currency) {
    const currency = tx.source_currency as Currency;
    const amount = BigInt(tx.source_amount);
    const custody = await ensureAccount(client, {
      key: `avenia:custody:${currency}`, type: "vendor_asset", currency,
    });
    const orgAccount = await ensureAccount(client, {
      key: `org:${tx.org_id}:${currency}`, type: "customer_liability", orgId: tx.org_id, currency,
    });
    try {
      await postBalancedTransactionOn(client, {
        description: `payout settled (reserved source amount)`,
        orgTransactionId: tx.id,
        idempotencyKey: `payout-settle:${tx.id}`,
        postings: [
          { accountId: custody, amount: -amount, currency },
          { accountId: orgAccount, amount: amount, currency },
        ],
      });
    } catch (e) {
      if (!(e instanceof DuplicateLedgerPostError)) throw e; // idempotent replay — never double-post
    }
  }

  // Customer notification on the terminal outcomes (PRD-06 §2C), same tx as the state
  // change. Exactly-once rides the monotonic guard above: a replayed status returns
  // "ignore"/"reject" before reaching here. on_hold/cancelled notify nothing — a hold
  // email is a tipping-off risk, and an unpaid-then-cancelled deposit is just noise.
  if (nextState === "settled") {
    await enqueueNotification(client, {
      eventType: "ticket_settled",
      recipientRef: tx.org_id,
      templateId: "ticket_paid",
      payload: { summary: paidSummary(tx), receipt: paidReceipt(tx) },
    });
  } else if (nextState === "failed") {
    await enqueueNotification(client, {
      eventType: "ticket_failed",
      recipientRef: tx.org_id,
      templateId: "ticket_failed",
    });
  }
  return "apply";
}

const SYMBOL: Record<string, string> = { BRL: "R$", BRLA: "R$", USD: "US$", USDT: "US$", USDC: "US$", EUR: "€", EURC: "€" };

function display(amount: string | null, ccy: string | null): string {
  if (!amount || !ccy) return "";
  return `${SYMBOL[ccy] ?? ccy} ${fromMinor(BigInt(amount), ccy as Currency).replace(".", ",")}`;
}

/** One pt-BR line per settled type, built from the row's ACTUAL amounts. */
function paidSummary(tx: ApplyRow): string {
  if (tx.type === "deposit") return `Depósito de ${display(tx.dest_amount, tx.dest_currency)} confirmado.`;
  if (tx.type === "convert_and_send") {
    return `Conversão concluída: ${display(tx.source_amount, tx.source_currency)} → ${display(tx.dest_amount, tx.dest_currency)}.`;
  }
  if (tx.type === "payout") {
    const sent = tx.dest_amount ? display(tx.dest_amount, tx.dest_currency) : display(tx.source_amount, tx.source_currency);
    return `Pagamento de ${sent} enviado.`;
  }
  return "Sua transação foi concluída.";
}

/** "4min32s" / "1h4min" / "45s" — settlement time from ticket creation to PAID. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}min` : ""}`;
}

/** pt-BR "as vendor quotes it" fee labels — unknown types fall back to the raw label. */
const FEE_LABELS: Record<string, string> = {
  "Markup Fee": "Serviço",
  "In Fee": "Entrada",
  "Out Fee": "Saída",
  "Crypto Fee": "Rede",
  "Gas Fee": "Rede",
};

/**
 * PRD-14 §5A ticket_paid v2 receipt: proof metrics from stored actuals — settlement time,
 * itemized vendor fees (no-spread presentation), effective FX rate when the legs are in
 * different display currencies. Returns "" or a paragraph ending in a blank line, so the
 * template renders clean either way. ponytail: rate is the all-in actual (dest/source);
 * the vs-market-mid comparison waits until mid-at-execution is stored on the row.
 */
function paidReceipt(tx: ApplyRow): string {
  const lines: string[] = [];
  const created = new Date(tx.created_at).getTime();
  if (Number.isFinite(created)) lines.push(`Liquidado em ${formatDuration(Date.now() - created)}.`);

  const rawFees = Array.isArray(tx.quote?.appliedFees) ? tx.quote.appliedFees : [];
  const fees = rawFees
    .filter((f): f is { type?: unknown; amount?: unknown; currency?: unknown } => typeof f === "object" && f !== null)
    .map((f) => {
      const ccy = String(f.currency ?? "BRL");
      const minor = vendorMinor(String(f.amount ?? ""), ccy as Currency);
      return { label: FEE_LABELS[String(f.type ?? "")] ?? String(f.type ?? "taxa"), minor, ccy };
    })
    .filter((f) => f.minor > 0n);
  if (fees.length) {
    lines.push(`Taxas: ${fees.map((f) => `${display(f.minor.toString(), f.ccy)} (${f.label})`).join(", ")}.`);
  }

  // Effective rate only when the legs display as different currencies (FX, not a transfer).
  if (
    tx.source_amount && tx.source_currency && tx.dest_amount && tx.dest_currency &&
    SYMBOL[tx.source_currency] !== SYMBOL[tx.dest_currency]
  ) {
    const srcMajor = Number(fromMinor(BigInt(tx.source_amount), tx.source_currency as Currency));
    const destMajor = Number(fromMinor(BigInt(tx.dest_amount), tx.dest_currency as Currency));
    // Present as R$ per 1 unit of the foreign leg — the direction customers quote.
    const brlIsSource = SYMBOL[tx.source_currency] === "R$";
    const rate = brlIsSource ? srcMajor / destMajor : destMajor / srcMajor;
    const foreign = brlIsSource ? tx.dest_currency : tx.source_currency;
    if (Number.isFinite(rate) && rate > 0 && (SYMBOL[tx.source_currency] === "R$" || SYMBOL[tx.dest_currency] === "R$")) {
      lines.push(`Câmbio efetivo: R$ ${rate.toFixed(4).replace(".", ",")} por ${SYMBOL[foreign] ?? foreign} 1,00.`);
    }
  }

  return lines.length ? lines.join(" ") + "\n\n" : "";
}
