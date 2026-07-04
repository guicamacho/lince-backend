/**
 * Inbound webhook signature verification registry.
 *
 * Clerk and Resend are Svix-signed — the exact `new Webhook(secret).verify(...)` pattern the
 * clerk route in app.ts already uses, lifted here so every provider goes through one seam.
 *
 * Avenia and Didit are STUBS: Avenia's docs specify OUTBOUND request signing only and give no
 * inbound webhook signature scheme; Didit's payloads are unconfirmed. We do NOT fabricate a
 * scheme — their verifier returns `{ ok: false }` so they are never treated as signature-verified.
 *
 * Secrets are passed in (VerifierConfig); the integrator wires env.webhooks in Wave 2.
 */
import { Webhook } from "svix";

export type VerifyResult = { ok: true; event: unknown } | { ok: false };

export type WebhookHeaders = Record<string, string | undefined>;

export interface VerifierConfig {
  clerkSecret?: string;
  resendSecret?: string;
  aveniaSecret?: string; // seam; inbound scheme unconfirmed
}

/** Providers we know how to verify (Svix). Everything else is store-only until confirmed. */
export const SVIX_PROVIDERS = new Set(["clerk", "resend"]);

function verifySvix(secret: string, rawBody: string, headers: WebhookHeaders): VerifyResult {
  try {
    const event = new Webhook(secret).verify(rawBody, {
      "svix-id": headers["svix-id"] ?? "",
      "svix-timestamp": headers["svix-timestamp"] ?? "",
      "svix-signature": headers["svix-signature"] ?? "",
    });
    return { ok: true, event };
  } catch {
    return { ok: false };
  }
}

export function verifyWebhook(
  provider: string,
  rawBody: string,
  headers: WebhookHeaders,
  config: VerifierConfig,
): VerifyResult {
  switch (provider) {
    case "clerk":
      return config.clerkSecret ? verifySvix(config.clerkSecret, rawBody, headers) : { ok: false };
    case "resend":
      return config.resendSecret ? verifySvix(config.resendSecret, rawBody, headers) : { ok: false };
    default:
      // avenia / didit / unknown — no confirmed inbound scheme; never claim verified.
      return { ok: false };
  }
}
