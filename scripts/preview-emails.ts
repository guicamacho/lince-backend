/**
 * Email preview harness (PRD-14 §4.5) — `npm run preview:emails`.
 *
 * Renders EVERY registered template with sample payloads to .preview/emails/ as HTML
 * (branded layout) and .txt (the reviewed plain text), plus an index page. Content and
 * compliance vetting happen on these files, not on code diffs. No DB, no network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATES, renderTemplate, type TemplateId } from "../src/modules/notifications/templates.js";

const APP_BASE_URL = process.env.NOTIFY_APP_BASE_URL ?? "https://lince-customer.fly.dev";
const OUT = join(process.cwd(), ".preview", "emails");

/** Representative payloads per template — extend when a template gains variables. */
const SAMPLES: Record<TemplateId, Record<string, unknown>> = {
  activation_approved: {},
  application_rejected: {},
  beneficiary_added: { label: "Fornecedor Sydney Pty Ltd" },
  application_received: {},
  rfi_requested: {},
  ticket_paid: {
    summary: "Pagamento de R$ 9,80 enviado.",
    receipt: "Liquidado em 4min32s. Taxas: R$ 0,20 (Saída). Câmbio efetivo: R$ 5,4321 por US$ 1,00.\n\n",
  },
  ticket_failed: {},
  ownership_transferred: { fromName: "Maria Souza", toName: "João Lima" },
  post_recovery_hold: {},
  admin_alert: { title: "sla_breach", detail: '{"orgId":"…","cnpj":"…","elapsedDays":3.2}' },
  closure_completed: { razaoSocial: "Acme Comércio Ltda" },
  beneficiary_destination_changed: { label: "Fornecedor Sydney Pty Ltd" },
  beneficiary_verified: { label: "Fornecedor Sydney Pty Ltd" },
  dispute_received_ack: { slaPrazo: "24 horas" },
  stale_warning_60d: {},
  stale_warning_80d: { daysLeft: 10 },
  application_expired: {},
  dormancy_outreach: {},
  returned_to_complete: {},
};

mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
for (const id of Object.keys(TEMPLATES) as TemplateId[]) {
  const t = TEMPLATES[id];
  const { subject, body, html } = renderTemplate(id, SAMPLES[id] ?? {}, APP_BASE_URL);
  writeFileSync(join(OUT, `${id}.txt`), `Subject: ${subject}\n\n${body}\n`);
  if (html) writeFileSync(join(OUT, `${id}.html`), html);
  rows.push(
    `<tr><td style="padding:6px 12px;"><a href="${html ? `${id}.html` : `${id}.txt`}">${id}</a></td>` +
      `<td style="padding:6px 12px;">v${t.version}</td><td style="padding:6px 12px;">${t.recipientClass}</td>` +
      `<td style="padding:6px 12px;">${t.recipientClass !== "admin" && !t.tipping_off_reviewed ? "UNREVIEWED (gate refuses)" : "sendable"}</td>` +
      `<td style="padding:6px 12px;">${subject}</td></tr>`,
  );
}
writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Lince email previews</title>
<body style="font-family:system-ui;padding:24px;"><h1>Lince email previews</h1>
<p>Rendered against ${APP_BASE_URL}. The .txt is the reviewed artifact; the .html adds chrome only.</p>
<table border="1" cellspacing="0" style="border-collapse:collapse;">
<tr><th style="padding:6px 12px;">template</th><th style="padding:6px 12px;">version</th><th style="padding:6px 12px;">class</th><th style="padding:6px 12px;">gate</th><th style="padding:6px 12px;">subject</th></tr>
${rows.join("\n")}</table></body>`,
);
console.log(`rendered ${Object.keys(TEMPLATES).length} templates -> ${OUT}/index.html`);
