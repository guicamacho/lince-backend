/**
 * Webhook receipt: verify (for providers with a confirmed scheme), persist raw, dedupe.
 *
 * Dedupe is the DB constraint `unique (provider_code, external_event_id)` (0001) — a re-delivery
 * is an `on conflict do nothing`, never a second row. Processing is a separate concern (processor.ts).
 *
 * Every known provider (clerk/resend/avenia/didit) is signature-verified and MUST pass or get
 * a 400 (and a greppable security warning for the log-drain alarm). There is no store-only
 * tier: unauthenticated bodies are never persisted.
 *
 * Returns the HTTP status the route should send; the integrator delegates the route body here.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { enqueueAdminAlert } from "../notifications/outbox.js";
import { env } from "../../config/env.js";
import { verifyWebhook, VERIFIED_PROVIDERS, KNOWN_PROVIDERS, type VerifierConfig, type WebhookHeaders } from "./verify.js";

export interface ReceiveInput {
  provider: string;
  externalId: string;
  eventType: string;
  rawBody: string; // used for signature verification
  payload: unknown; // persisted as jsonb
  headers: WebhookHeaders;
  config: VerifierConfig;
  clientIp?: string;
}

export interface ReceiptOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function receiveWebhook(input: ReceiveInput): Promise<ReceiptOutcome> {
  const { provider, externalId, eventType, rawBody, payload, headers, config, clientIp } = input;

  // Reject unknown providers BEFORE any insert: the route is unauthenticated + un-throttled,
  // so storing arbitrary-provider bodies is an unbounded storage-exhaustion vector.
  if (!KNOWN_PROVIDERS.has(provider)) {
    return { status: 404, body: { error: "unknown_provider" } };
  }

  // PRD-07 volume ALARM (never a block — providers retry and a 429 becomes a delivery gap):
  // count every known-provider intake attempt per minute; crossing the threshold pings ops
  // exactly once per window. Reuses the fixed-window rate_limits table.
  await recordWebhookVolume(provider);

  if (VERIFIED_PROVIDERS.has(provider)) {
    const configured =
      provider === "clerk" ? !!config.clerkSecret
      : provider === "resend" ? !!config.resendSecret
      : provider === "didit" ? !!config.diditSecret
      : !!config.aveniaPublicKey;
    if (!configured) return { status: 503, body: { error: "webhook_not_configured" } };
    if (!(await verifyWebhook(provider, rawBody, headers, config)).ok) {
      // Greppable -> log-drain alarm. ponytail: log-based alert now; swap to a Slack enqueue
      // (B6) once SlackAdapter is configured — one line.
      console.warn("security.webhook_signature_failed", JSON.stringify({ provider, ip: clientIp ?? null }));
      return { status: 400, body: { error: "invalid_signature" } };
    }
  }

  await pool.query(
    `insert into webhook_events (provider_code, external_event_id, event_type, payload)
       values ($1, $2, $3, $4)
     on conflict (provider_code, external_event_id) do nothing`,
    [provider, externalId, eventType, JSON.stringify(payload ?? {})],
  );
  return { status: 202, body: { received: true } };
}

/** Fixed-window per-provider intake counter + one ops alert at the crossing. Failures here
 *  must never break intake — swallow and log. */
async function recordWebhookVolume(provider: string): Promise<void> {
  const threshold = env.webhooks.volumeAlarmPerMin;
  if (!threshold) return;
  try {
    const { rows } = await pool.query<{ count: number }>(
      `insert into rate_limits (key, route_class, window_start, count)
       values ($1, 'webhook_volume', to_timestamp(floor(extract(epoch from now()) / 60) * 60), 1)
       on conflict (key, route_class, window_start)
       do update set count = rate_limits.count + 1
       returning count`,
      [`webhook_volume:${provider}`],
    );
    if (rows[0]!.count === threshold + 1) {
      console.warn("security.webhook_volume_alarm", JSON.stringify({ provider, threshold }));
      await withTransaction((c) =>
        enqueueAdminAlert(c, "webhook_volume_alarm", { provider, threshold, window: "1m" }),
      );
    }
  } catch (e) {
    console.warn("webhook_volume_counter_failed", e instanceof Error ? e.message : String(e));
  }
}
