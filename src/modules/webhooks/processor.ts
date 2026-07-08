/**
 * Webhook processor — drains stored events, dispatches by provider, tracks retries.
 *
 * Claim pattern: `for update skip locked` over `received` + retryable `failed` rows, so a
 * poisoned row never blocks the queue and a second drainer is safe (wasteful, not wrong).
 *
 * Backoff: webhook_events has no per-attempt timestamp column, so retry cadence IS the drain
 * interval — each tick advances a failed row one attempt (linear backoff at the tick), dead-lettering
 * at maxAttempts. ponytail: linear backoff at drain cadence; add next_attempt_at (a migration) for
 * exponential only if retry storms appear.
 */
import type pg from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { linkClerkUserFromEvent, type ClerkUserEvent } from "../identity/clerkSync.js";
import { applyTicketStatus } from "../money/ticketApply.js";

export interface WebhookEventRow {
  id: string;
  provider_code: string;
  external_event_id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
}

export type WebhookHandler = (client: pg.PoolClient, row: WebhookEventRow) => Promise<void>;

export interface DrainOptions {
  handlers?: Record<string, WebhookHandler>;
  limit?: number;
  maxAttempts?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_ATTEMPTS = 8;

/** Clerk events are idempotently linked into `people` (same helper the receipt route uses). */
const clerkHandler: WebhookHandler = async (_client, row) => {
  await linkClerkUserFromEvent(row.payload as ClerkUserEvent);
};

/**
 * Avenia TICKET events (envelope observed live: { event: { id, data: { type, ticket } } }).
 * Row lock (FOR UPDATE) + the pure monotonic guard (via applyTicketStatus) = idempotent,
 * out-of-order-safe state application. Tickets with no matching row (master/faucet or
 * pre-producer tickets) are ignored on purpose.
 * ponytail: ledger postings on PAID belong to the postings WP (needs per-org ledger
 * accounts); until then settled state lives on org_transactions only.
 */
const aveniaHandler: WebhookHandler = async (client, row) => {
  const data = (row.payload as { event?: { data?: { ticket?: { id?: string; status?: string } } } } | null)
    ?.event?.data;
  const ticket = data?.ticket;
  if (!ticket?.id || !ticket.status) return; // not a ticket envelope (e.g. KYC events later)
  const { rows } = await client.query<{ id: string; quote: { ticketStatus?: string } | null }>(
    `select id, quote from org_transactions where provider_code = $1 and vendor_ref = $2 for update`,
    [row.provider_code, ticket.id],
  );
  const tx = rows[0];
  if (!tx) return;
  const decision = await applyTicketStatus(client, tx, ticket.status);
  if (decision === "reject") {
    // Don't poison the queue over an unknown state; greppable for the log alarm.
    console.warn("avenia.ticket_state_unknown", JSON.stringify({ vendorRef: ticket.id, incoming: ticket.status }));
  }
};

const DEFAULT_HANDLERS: Record<string, WebhookHandler> = {
  clerk: clerkHandler,
  avenia: aveniaHandler,
};

/**
 * Dispatch one claimed row; mark processed, or increment attempts and fail/dead on throw.
 * Must run inside a transaction (drainWebhooks provides one): each row gets a SAVEPOINT so a
 * handler whose SQL errors aborts only its own savepoint — without it the failure UPDATE below
 * would throw 25P02 on the aborted batch transaction, rolling back every sibling and never
 * incrementing attempts, so the poison row would re-fail forever instead of dead-lettering.
 */
export async function processWebhookEvent(
  client: pg.PoolClient,
  row: WebhookEventRow,
  handlers: Record<string, WebhookHandler>,
  maxAttempts: number,
): Promise<void> {
  const handler = handlers[row.provider_code];
  await client.query("savepoint webhook_row");
  try {
    if (handler) await handler(client, row); // unknown provider -> no-op success
    await client.query(`update webhook_events set status = 'processed', processed_at = now() where id = $1`, [
      row.id,
    ]);
    await client.query("release savepoint webhook_row");
  } catch (err) {
    await client.query("rollback to savepoint webhook_row");
    const attempts = row.attempts + 1;
    const status = attempts >= maxAttempts ? "dead" : "failed";
    await client.query(`update webhook_events set status = $2, attempts = $3, last_error = $4 where id = $1`, [
      row.id,
      status,
      attempts,
      err instanceof Error ? err.message : String(err),
    ]);
  }
}

/** Claim a batch and process it. Returns the number of rows claimed. */
export async function drainWebhooks(opts: DrainOptions = {}): Promise<number> {
  const { handlers = DEFAULT_HANDLERS, limit = DEFAULT_LIMIT, maxAttempts = DEFAULT_MAX_ATTEMPTS } = opts;
  return withTransaction(async (client) => {
    const { rows } = await client.query<WebhookEventRow>(
      `select id, provider_code, external_event_id, event_type, payload, status, attempts
         from webhook_events
        where status = 'received' or (status = 'failed' and attempts < $1)
        order by received_at
        for update skip locked
        limit $2`,
      [maxAttempts, limit],
    );
    for (const row of rows) await processWebhookEvent(client, row, handlers, maxAttempts);
    return rows.length;
  });
}

/** Ops/admin reset: send a failed/dead event back through the drain. Idempotent handlers keep it safe. */
export async function replayWebhookEvent(id: string): Promise<void> {
  await pool.query(
    `update webhook_events set status = 'received', attempts = 0, last_error = null, processed_at = null where id = $1`,
    [id],
  );
}
