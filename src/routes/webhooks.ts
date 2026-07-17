/**
 * Inbound webhook intake: verify -> persist -> dedupe, delegated to the inbox module.
 * Never throttled (providers retry; a 429 turns a retry into a delivery gap).
 */
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { env } from "../config/env.js";
import { rateLimit } from "../modules/ratelimit/middleware.js";
import { receiveWebhook } from "../modules/webhooks/inbox.js";
import { aveniaWebhookPublicKey } from "../modules/webhooks/aveniaKey.js";

// Per-provider inbound webhook secrets, resolved once from env for the verify registry.
// Avenia's is a published public key, fetched+cached from the API (RSA-PSS over raw body).
const webhookVerifierConfig = {
  clerkSecret: env.clerk.webhookSigningSecret,
  resendSecret: env.webhooks.resendSecret,
  aveniaPublicKey: aveniaWebhookPublicKey,
  diditSecret: env.didit.webhookSecret,
};

// Shared webhook route body: build the receipt input from the request and delegate to the
// inbox module (verify → persist → dedupe). The dedup id must come from a SIGNED source per
// provider, never an unsigned header an attacker can vary to bypass replay dedup:
//   clerk/resend -> svix-id (part of the Svix-signed set); avenia -> event.id (inside the
//   PSS-signed body). Unsigned x-event-id is only a last-resort for providers with no scheme.
async function handleWebhook(req: Request, res: Response, provider: string): Promise<void> {
  const body = (req.body ?? {}) as { id?: unknown; type?: unknown; eventId?: unknown; eventType?: unknown };
  // Avenia wraps everything: { event: { id, data: { type, ticket } } } (observed live 2026-07-07).
  const avenia = (req.body as { event?: { id?: unknown; data?: { type?: unknown } } } | null)?.event;
  // Signed sources first: svix-id (Svix-signed set), then body ids (inside an HMAC/PSS-signed
  // body). The unsigned x-event-id header is a last resort only — never let it shadow a signed id.
  const externalId = String(
    provider === "avenia"
      ? (avenia?.id ?? randomUUID())
      : (req.header("svix-id") ?? body.id ?? body.eventId ?? req.header("x-event-id") ?? randomUUID()),
  );
  const outcome = await receiveWebhook({
    provider,
    externalId,
    eventType: String(body.type ?? body.eventType ?? avenia?.data?.type ?? "unknown"),
    rawBody: (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "",
    payload: req.body ?? {},
    headers: {
      "svix-id": req.header("svix-id"),
      "svix-timestamp": req.header("svix-timestamp"),
      "svix-signature": req.header("svix-signature"),
      signature: req.header("signature"), // Avenia: base64 RSA-PSS over the raw body
      "x-signature": req.header("x-signature"), // Didit: hex HMAC-SHA256 over the raw body
    },
    config: webhookVerifierConfig,
    clientIp: req.ip,
  });
  res.status(outcome.status).json(outcome.body);
}

export function registerWebhookRoutes(app: Express): void {
  // Clerk webhook — SIGNATURE-VERIFIED (Svix). Registered before the generic /webhooks/:provider.
  // This is the control that keeps the endpoint from being "open to everyone": no valid
  // Svix signature -> rejected. Delegated to the webhook inbox module; the drain scheduler's
  // clerkHandler links the user from the stored event (idempotent). Never throttled.
  app.post("/webhooks/clerk", rateLimit("webhook_exempt"), async (req: Request, res: Response) => {
    await handleWebhook(req, res, "clerk");
  });

  // Generic webhook intake — every known provider is signature-verified in the inbox
  // (resend Svix, avenia RSA-PSS, didit HMAC); unknown providers are rejected, nothing
  // is stored unverified. Delegated to the same inbox module. Never throttled.
  app.post("/webhooks/:provider", rateLimit("webhook_exempt"), async (req: Request, res: Response) => {
    await handleWebhook(req, res, String(req.params.provider));
  });
}
