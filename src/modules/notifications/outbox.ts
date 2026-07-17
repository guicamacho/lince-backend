/**
 * Notification outbox (PRD-06 §2A / PRD-07 §2.6).
 *
 * enqueueNotification writes a row using the CALLER's transaction client, so a
 * notification exists iff the triggering change commits (acceptance #1). The drain
 * worker resolves the recipient to an address, checks the suppression list, renders +
 * sends via the selected adapter, and records a system audit_log entry on success
 * (acceptance #4).
 *
 * Recipient resolution (Cluster 1): recipient_ref containing "@" is a literal email;
 * anything else is treated as an org id and resolves to the org's ACTIVE OWNER's email
 * at send time. Unresolvable or suppressed recipients dead-letter the row (never a
 * retry loop — the ref won't get better).
 *
 * ponytail: in-process drain (drainOutboxOnce) called from the server's guarded scheduler
 *   on the single always-on machine. SKIP LOCKED makes a second instance safe (wasteful,
 *   not wrong); move to a dedicated worker only if volume grows.
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
  recipientRef: string; // org id (resolved to the owner's email at send time) or a literal email
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

/**
 * Ops alert (Slack, or LogAdapter when unconfigured) through the same outbox: durable and
 * transactional with the triggering change, drained by the same worker. SlackAdapter
 * ignores recipient_ref — callers that need dedupe (the SLA sweep) pass a meaningful ref
 * and query on it; everyone else takes the default "ops".
 */
export async function enqueueAdminAlert(
  client: pg.PoolClient,
  kind: string,
  detail: Record<string, unknown>,
  recipientRef = "ops",
): Promise<void> {
  await enqueueNotification(client, {
    eventType: kind,
    recipientRef,
    templateId: "admin_alert",
    payload: { title: kind, detail: JSON.stringify(detail) },
  });
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

/**
 * recipient_ref -> deliverable email. Literal emails pass through lowercased; anything
 * else is an org id -> the active owner's login email (PRD-06 §2A: the owner is the
 * accountable recipient; per-member routing is a later phase). org_id::text avoids a
 * uuid cast throw on a malformed ref — malformed just resolves to null and dead-letters.
 */
async function resolveRecipientEmail(client: pg.PoolClient, ref: string): Promise<string | null> {
  if (ref.includes("@")) return ref.toLowerCase();
  const { rows } = await client.query<{ email: string }>(
    `select p.email
       from org_people op join people p on p.id = op.person_id
      where op.org_id::text = $1 and 'owner' = any(op.roles) and op.status = 'active'
      limit 1`,
    [ref],
  );
  return rows[0]?.email.toLowerCase() ?? null;
}

async function processRow(client: pg.PoolClient, cfg: NotifyConfig, select: SelectAdapter, row: OutboxRow): Promise<void> {
  const template = getTemplate(row.template_id);
  if (!template) return markDead(client, row, "unknown_template");
  // Tipping-off gate: a non-admin template that hasn't been review-cleared never sends.
  if (!isSendable(template)) return markDead(client, row, "tipping_off_unreviewed");

  // Customer/payee sends go to a real address; admin sends go to Slack (ref unused).
  let to = row.recipient_ref;
  if (template.recipientClass !== "admin") {
    const email = await resolveRecipientEmail(client, row.recipient_ref);
    if (!email) return markDead(client, row, "recipient_unresolved");
    const suppressed = await client.query(`select 1 from notification_suppressions where email = $1`, [email]);
    if (suppressed.rowCount) return markDead(client, row, "recipient_suppressed");
    to = email;
  }

  const rendered = renderTemplate(row.template_id as TemplateId, row.payload);
  const adapter = select(template.recipientClass, cfg);
  let result;
  try {
    result = await adapter.send(rendered, to, row.id);
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
      `update notification_outbox
          set status = 'sent', sent_at = now(), attempts = attempts + 1, audit_ref = $2, provider_ref = $3
        where id = $1`,
      [row.id, rows[0]!.id, result.providerRef || null],
    );
  } else {
    const next = row.attempts + 1;
    // ponytail: no last_error column on notification_outbox (schema is fixed this session);
    //   the failure reason is logged, not persisted. Add a column if ops needs it in-row.
    console.warn("notify.send_failed", { outboxId: row.id, attempt: next, error: result.error });
    const dead = next >= MAX_ATTEMPTS;
    await client.query(
      `update notification_outbox set status = $2, attempts = $3 where id = $1`,
      [row.id, dead ? "dead" : "failed", next],
    );
    if (dead) await alertDeadRow(client, row, result.error);
  }
}

/** Refuse without sending — unknown template, unreviewed copy, or unusable recipient. */
async function markDead(client: pg.PoolClient, row: OutboxRow, reason: string): Promise<void> {
  console.warn("notify.refused", { outboxId: row.id, reason });
  await client.query(`update notification_outbox set status = 'dead' where id = $1`, [row.id]);
  await alertDeadRow(client, row, reason);
}

/** Every dead-lettered notification pings ops — EXCEPT dead alerts themselves (no cycles). */
async function alertDeadRow(client: pg.PoolClient, row: OutboxRow, reason: string): Promise<void> {
  if (row.template_id === "admin_alert") return;
  await enqueueAdminAlert(client, "notification_dead", {
    outboxId: row.id,
    templateId: row.template_id,
    recipientRef: row.recipient_ref,
    reason,
  });
}
