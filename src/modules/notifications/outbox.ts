/**
 * Notification outbox (PRD-06 §2A / PRD-07 §2.6).
 *
 * enqueueNotification writes a row using the CALLER's transaction client, so a
 * notification exists iff the triggering change commits (acceptance #1). The drain
 * worker claims queued/retryable rows with FOR UPDATE SKIP LOCKED, renders + sends via
 * the selected adapter, and records a system audit_log entry on success (acceptance #4).
 *
 * ponytail: in-process drain (drainOutboxOnce) called from app.ts's guarded scheduler on
 *   the single always-on machine. SKIP LOCKED makes a second instance safe (wasteful, not
 *   wrong); move to a dedicated worker only if volume grows.
 */
import type pg from "pg";
import { withTransaction } from "../../db/pool.js";
import { getTemplate, isSendable, renderTemplate, type RecipientClass, type TemplateId } from "./templates.js";
import { selectAdapter, type NotifyConfig, type SendAdapter } from "./adapters.js";

/** Dead-letter after this many failed attempts. */
export const MAX_ATTEMPTS = 5;
const BATCH = 20;

export interface EnqueueInput {
  eventType: string;
  recipientRef: string; // who to notify (org id in P1; resolved to an address at send time)
  templateId: TemplateId;
  templateVersion?: number;
  payload?: Record<string, unknown>;
}

/**
 * Enqueue in the caller's transaction. Never opens its own tx — the row is only visible
 * if the caller commits.
 */
export async function enqueueNotification(client: pg.PoolClient, input: EnqueueInput): Promise<void> {
  await client.query(
    `insert into notification_outbox (event_type, recipient_ref, template_id, template_version, payload)
     values ($1, $2, $3, $4, $5)`,
    [
      input.eventType,
      input.recipientRef,
      input.templateId,
      input.templateVersion ?? getTemplate(input.templateId)?.version ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

interface OutboxRow {
  id: string;
  template_id: string;
  recipient_ref: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Type of selectAdapter — injectable so tests can supply a fake adapter (acceptance #5). */
type SelectAdapter = (rc: RecipientClass, cfg: NotifyConfig) => SendAdapter;

/**
 * Drain one batch. Claims rows with FOR UPDATE SKIP LOCKED so a poisoned row never blocks
 * the queue (acceptance #2). Returns the number of rows processed.
 * `select` is injectable purely for tests; production passes the default.
 */
export async function drainOutboxOnce(cfg: NotifyConfig, select: SelectAdapter = selectAdapter): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<OutboxRow>(
      `select id, template_id, recipient_ref, payload, attempts
         from notification_outbox
        where status = 'queued' or (status = 'failed' and attempts < $1)
        order by created_at
        for update skip locked
        limit $2`,
      [MAX_ATTEMPTS, BATCH],
    );
    // Per-row SAVEPOINT: a DB error while finalizing one row must NOT roll back the batch and
    // re-send siblings whose external send already succeeded (mirrors the webhook processor).
    for (const row of rows) {
      await client.query("savepoint outbox_row");
      try {
        await processRow(client, cfg, select, row);
        await client.query("release savepoint outbox_row");
      } catch (err) {
        await client.query("rollback to savepoint outbox_row");
        console.warn("outbox.row_failed", { outboxId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return rows.length;
  });
}

async function processRow(client: pg.PoolClient, cfg: NotifyConfig, select: SelectAdapter, row: OutboxRow): Promise<void> {
  const template = getTemplate(row.template_id);
  if (!template) return markDead(client, row.id, "unknown_template");
  // Tipping-off gate: a non-admin template that hasn't been review-cleared never sends.
  if (!isSendable(template)) return markDead(client, row.id, "tipping_off_unreviewed");

  const rendered = renderTemplate(row.template_id as TemplateId, row.payload);
  const adapter = select(template.recipientClass, cfg);
  let result;
  try {
    result = await adapter.send(rendered, row.recipient_ref, row.id);
  } catch (err) {
    result = { ok: false as const, error: String(err) };
  }

  if (result.ok) {
    const { rows } = await client.query<{ id: string }>(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values (null, 'system', null, 'notification.sent', $1) returning id`,
      [JSON.stringify({ outboxId: row.id, templateId: row.template_id, providerRef: result.providerRef })],
    );
    await client.query(
      `update notification_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, audit_ref = $2 where id = $1`,
      [row.id, rows[0]!.id],
    );
  } else {
    const next = row.attempts + 1;
    // ponytail: no last_error column on notification_outbox (schema is fixed this session);
    //   the failure reason is logged, not persisted. Add a column if ops needs it in-row.
    console.warn("notify.send_failed", { outboxId: row.id, attempt: next, error: result.error });
    await client.query(
      `update notification_outbox set status = $2, attempts = $3 where id = $1`,
      [row.id, next >= MAX_ATTEMPTS ? "dead" : "failed", next],
    );
  }
}

/** Refuse without sending — unknown template or tipping-off-unreviewed copy. */
async function markDead(client: pg.PoolClient, id: string, reason: string): Promise<void> {
  console.warn("notify.refused", { outboxId: id, reason });
  await client.query(`update notification_outbox set status = 'dead' where id = $1`, [id]);
}
