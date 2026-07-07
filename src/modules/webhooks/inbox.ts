/**
 * Webhook receipt: verify (for providers with a confirmed scheme), persist raw, dedupe.
 *
 * Dedupe is the DB constraint `unique (provider_code, external_event_id)` (0001) — a re-delivery
 * is an `on conflict do nothing`, never a second row. Processing is a separate concern (processor.ts).
 *
 * Signature-verified providers (clerk/resend/avenia) MUST pass or get a 400 (and a greppable
 * security warning for the log-drain alarm). Providers whose inbound scheme is unconfirmed
 * (didit) are stored ONLY — kept ready for the day the scheme lands, never processed as trusted.
 *
 * Returns the HTTP status the route should send; the integrator delegates the route body here.
 */
import { pool } from "../../db/pool.js";
import { verifyWebhook, VERIFIED_PROVIDERS, type VerifierConfig, type WebhookHeaders } from "./verify.js";

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

  if (VERIFIED_PROVIDERS.has(provider)) {
    const configured =
      provider === "clerk" ? !!config.clerkSecret
      : provider === "resend" ? !!config.resendSecret
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
