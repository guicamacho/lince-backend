/**
 * Inbound webhook signature verification registry.
 *
 * Clerk and Resend are Svix-signed — the exact `new Webhook(secret).verify(...)` pattern the
 * clerk route in app.ts already uses, lifted here so every provider goes through one seam.
 *
 * Avenia signs webhooks with RSA-PSS (SHA-256, MGF1, max salt) over the RAW request body,
 * base64 in the `Signature` header, against the key published at GET /v2/public-key
 * (integration guide: Webhooks/verifyingWebhookAuthenticity). NOTE this differs from
 * Avenia's OUTBOUND request signing (PKCS#1 v1.5) — do not reuse the request signer.
 *
 * Didit signs with HMAC-SHA256 over the RAW body (hex in `x-signature`), keyed by the
 * dashboard webhook secret (docs.didit.me → Webhooks). Verified here so /webhooks/didit is
 * never an unauthenticated unbounded-insert vector (verification sweep, 2026-07-11).
 *
 * Secrets/keys are passed in (VerifierConfig); the integrator wires env + fetchers in app.ts.
 */
import { Webhook } from "svix";
import { createPublicKey, verify as cryptoVerify, constants, createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult = { ok: true; event: unknown } | { ok: false };

export type WebhookHeaders = Record<string, string | undefined>;

export interface VerifierConfig {
  clerkSecret?: string;
  resendSecret?: string;
  /** Resolves Avenia's webhook public key PEM (GET /v2/public-key); caller caches. */
  aveniaPublicKey?: () => Promise<string | null>;
  diditSecret?: string;
}

/** Providers verified via Svix. */
export const SVIX_PROVIDERS = new Set(["clerk", "resend"]);
/** Providers with a CONFIRMED inbound scheme — signature required at intake. */
export const VERIFIED_PROVIDERS = new Set(["clerk", "resend", "avenia", "didit"]);
/** Every provider the intake will accept. Anything else is rejected (no unbounded storage of
 *  unauthenticated junk). Every known provider is now signature-verified — a new store-only
 *  provider must NOT be added here without a scheme (that re-opens the unbounded-insert hole). */
export const KNOWN_PROVIDERS = new Set(["clerk", "resend", "avenia", "didit"]);

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

/** RSA-PSS over the raw body; salt length auto-detected on verify. */
function verifyAveniaPss(publicKeyPem: string, rawBody: string, signatureB64: string): boolean {
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(rawBody, "utf8"),
      {
        key: createPublicKey(publicKeyPem),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_AUTO,
      },
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export async function verifyWebhook(
  provider: string,
  rawBody: string,
  headers: WebhookHeaders,
  config: VerifierConfig,
): Promise<VerifyResult> {
  switch (provider) {
    case "clerk":
      return config.clerkSecret ? verifySvix(config.clerkSecret, rawBody, headers) : { ok: false };
    case "resend":
      return config.resendSecret ? verifySvix(config.resendSecret, rawBody, headers) : { ok: false };
    case "avenia": {
      const signature = headers["signature"];
      if (!signature || !config.aveniaPublicKey) return { ok: false };
      const pem = await config.aveniaPublicKey();
      if (!pem) return { ok: false };
      return verifyAveniaPss(pem, rawBody, signature) ? { ok: true, event: rawBody } : { ok: false };
    }
    case "didit": {
      const signature = headers["x-signature"];
      if (!signature || !config.diditSecret) return { ok: false };
      return verifyDiditHmac(config.diditSecret, rawBody, signature) ? { ok: true, event: rawBody } : { ok: false };
    }
    default:
      // unknown — no confirmed inbound scheme; never claim verified.
      return { ok: false };
  }
}

/** HMAC-SHA256 hex over the raw body; constant-time compare. */
function verifyDiditHmac(secret: string, rawBody: string, signatureHex: string): boolean {
  try {
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    const given = Buffer.from(signatureHex, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}
