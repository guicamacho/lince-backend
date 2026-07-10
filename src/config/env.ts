/** Env loading + validation. Fail fast if required vars are missing. */
// Dev convenience: load a local .env only when DATABASE_URL isn't already set.
// (Tests set DATABASE_URL=lince_test inline, so this skip keeps them off the dev DB;
//  prod injects env, so this no-ops there too.)
if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(); } catch { /* no .env file — rely on process.env */ }
}
import { resolvePem } from "./keys.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  clerk: {
    secretKey: optional("CLERK_SECRET_KEY"),
    publishableKey: optional("CLERK_PUBLISHABLE_KEY"),
    webhookSigningSecret: optional("CLERK_WEBHOOK_SIGNING_SECRET"),
  },
  avenia: {
    baseUrl: optional("AVENIA_BASE_URL") ?? "https://api.sandbox.avenia.io:10952",
    apiKey: optional("AVENIA_API_KEY"),
    // PEM via file path (AVENIA_SIGNING_KEY_FILE) or escaped/base64 env value.
    signingPrivateKeyPem: resolvePem(optional("AVENIA_SIGNING_PRIVATE_KEY"), optional("AVENIA_SIGNING_KEY_FILE")),
  },
  didit: {
    apiKey: optional("DIDIT_API_KEY"),
    webhookSecret: optional("DIDIT_WEBHOOK_SECRET"),
  },
  // Step-up (re-auth) gate for sensitive mutations. Off unless exactly "true".
  stepUp: {
    enforced: process.env.STEP_UP_ENFORCED === "true",
  },
  // Notification outbox (B6). Sending is OFF unless emailAdapter is "resend"; the
  // default "log" adapter never touches the network. Slack is for admin alerts.
  notify: {
    emailAdapter: (optional("NOTIFY_EMAIL_ADAPTER") ?? "log") as "log" | "resend",
    resendApiKey: optional("NOTIFY_RESEND_API_KEY"),
    from: optional("NOTIFY_FROM"),
    replyTo: optional("NOTIFY_REPLY_TO"),
    slackWebhookUrl: optional("NOTIFY_SLACK_WEBHOOK_URL"),
  },
  // MFA policy (B15). Ruling (PRD-07 v5): optional by default (config-only flip to
  // mandatory), SMS disabled, 24h post-recovery money-out hold.
  mfa: {
    policy: (process.env.MFA_POLICY === "mandatory" ? "mandatory" : "optional") as "optional" | "mandatory",
    smsEnabled: process.env.MFA_SMS_ENABLED === "true",
    recoveryHoldHours: Number(optional("RECOVERY_HOLD_HOURS") ?? 24),
  },
  // API rate limiting (B13). Off unless exactly "true" (dev/tests aren't throttled).
  // webhookMaxBytes caps the JSON body express parses (webhook intake needs > 100kb).
  rateLimit: {
    enforced: process.env.RATE_LIMIT_ENFORCED === "true",
    webhookMaxBytes: optional("WEBHOOK_MAX_BYTES") ?? "1mb",
    // Exact number of trusted proxy hops in front of the app (Cloudflare tunnel + Fly). MUST be
    // set to the real hop count before enabling rate limiting in prod: too low collapses every
    // client to the edge IP (self-DoS), too high (or `true`) lets X-Forwarded-For be spoofed to
    // bypass IP limits. Default 0 (dev has no proxy) — Express then uses the socket IP.
    trustProxyHops: Number(optional("TRUST_PROXY_HOPS") ?? 0),
  },
  // Inbound webhook signing secrets (B3). Clerk lives under clerk.webhookSigningSecret;
  // resend is Svix-signed; avenia verifies against its published public key (no env secret —
  // see modules/webhooks/aveniaKey.ts).
  webhooks: {
    resendSecret: optional("RESEND_WEBHOOK_SECRET"),
  },
  // Shared secret for server-to-server /admin/* calls from the admin app (which
  // authenticates staff via its own, separate Clerk instance).
  adminServiceToken: optional("ADMIN_SERVICE_TOKEN"),
  // Admission SLA threshold (days) for the aging instrument (PRD-04 §4.3). Wall-clock
  // per canon (business-day math is reserved for IFTI/SMR). Default 2.
  sla: {
    admissionDays: Number(optional("ADMISSION_SLA_DAYS") ?? 2),
  },
} as const;
