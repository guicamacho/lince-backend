/**
 * Send adapters (PRD-06 §2A, acceptance #5: swapping adapters touches nothing outside
 * the adapter). Config is passed as a PARAMETER — the integrator wires env.notify in
 * Wave 2; nothing here reads process.env.
 *
 * LogAdapter is the DEFAULT for every class. ResendAdapter is code-complete but is only
 * selected when NOTIFY_EMAIL_ADAPTER==="resend" AND a key/from are present — so the
 * default path never hits the network and tests never send.
 */
import type { RecipientClass } from "./templates.js";

export interface Rendered {
  subject: string;
  body: string;
}

export type SendResult = { ok: true; providerRef: string } | { ok: false; error: string };

export interface SendAdapter {
  /** `idempotencyKey` = the outbox row id, so a redelivery de-dupes upstream. */
  send(rendered: Rendered, recipientRef: string, idempotencyKey: string): Promise<SendResult>;
}

/** Shape of env.notify (Wave 2 supplies it). All optional except emailAdapter. */
export interface NotifyConfig {
  emailAdapter: "log" | "resend";
  resendApiKey?: string;
  from?: string;
  replyTo?: string;
  slackWebhookUrl?: string;
}

/** Default adapter — logs and succeeds. Dev/sandbox, and the fallback whenever a live
 *  adapter isn't configured. Never touches the network. */
export class LogAdapter implements SendAdapter {
  async send(rendered: Rendered, recipientRef: string, idempotencyKey: string): Promise<SendResult> {
    console.log("notify.log_adapter", { to: recipientRef, subject: rendered.subject, ref: idempotencyKey });
    return { ok: true, providerRef: `log:${idempotencyKey}` };
  }
}

/** Resend email via plain fetch (no SDK). Code-complete, OFF by default. */
export class ResendAdapter implements SendAdapter {
  constructor(private cfg: { apiKey: string; from: string; replyTo?: string }) {}
  async send(rendered: Rendered, recipientRef: string, idempotencyKey: string): Promise<SendResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey, // Resend de-dupes on this
        },
        body: JSON.stringify({
          from: this.cfg.from,
          to: recipientRef,
          subject: rendered.subject,
          text: rendered.body,
          ...(this.cfg.replyTo ? { reply_to: this.cfg.replyTo } : {}),
        }),
      });
      if (!res.ok) return { ok: false, error: `resend_${res.status}` };
      const data = (await res.json()) as { id?: string };
      return { ok: true, providerRef: data.id ?? "" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

/** Admin alerts to a Slack incoming webhook via plain fetch. Falls back to LogAdapter
 *  when no URL is configured (see selectAdapter). */
export class SlackAdapter implements SendAdapter {
  constructor(private webhookUrl: string) {}
  async send(rendered: Rendered, _recipientRef: string, _idempotencyKey: string): Promise<SendResult> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${rendered.subject}*\n${rendered.body}` }),
      });
      return res.ok ? { ok: true, providerRef: "slack" } : { ok: false, error: `slack_${res.status}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

/**
 * Pick the adapter for a recipient class. Default is LogAdapter everywhere; a live
 * adapter is chosen only when fully configured, so the default path never sends.
 */
export function selectAdapter(recipientClass: RecipientClass, cfg: NotifyConfig): SendAdapter {
  if (recipientClass === "admin") {
    return cfg.slackWebhookUrl ? new SlackAdapter(cfg.slackWebhookUrl) : new LogAdapter();
  }
  // customer / payee → email
  if (cfg.emailAdapter === "resend" && cfg.resendApiKey && cfg.from) {
    return new ResendAdapter({ apiKey: cfg.resendApiKey, from: cfg.from, replyTo: cfg.replyTo });
  }
  return new LogAdapter();
}
