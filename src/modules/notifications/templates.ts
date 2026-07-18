/**
 * Notification template registry (PRD-06 §2A) — CODE, not a DB table.
 *
 * Each template is a versioned artifact. The drain worker renders `subject`/`body`
 * against the outbox row's payload and enforces the tipping-off gate below.
 *
 * TIPPING-OFF GATE (Modelo A / AUSTRAC): a customer- or payee-facing template may
 * only send once it has been reviewed to be tipping-off-safe (`tipping_off_reviewed`).
 * Admin-facing templates are exempt (staff are inside the compliance boundary).
 *
 * PAYEE CLASS — DESIGN NOTE ONLY (B16, do NOT build here): the shape carries
 * recipientClass:"payee" for a future `payment_advice_paid`. That template will fire
 * on a PAID ticket ONLY, with a stricter review bar than the customer copy: the payer
 * memo must be plain-text-escaped, URL-stripped and length-capped before it reaches a
 * third-party payee. No payee template, no suppression list, no migration 0008 now.
 */

import { renderEmailHtml, type EmailCta } from "./emailHtml.js";

export type RecipientClass = "customer" | "admin" | "payee";

export interface Template {
  version: number;
  locale: "pt-BR";
  subject: string;
  body: string; // {{var}} placeholders filled from the outbox row payload
  tipping_off_reviewed: boolean;
  recipientClass: RecipientClass;
  /** At most one button (PRD-14 §3). Label+path are part of the reviewed artifact. */
  cta?: EmailCta;
}

/**
 * v1 registry. Templates with a LIVE enqueue site are review-cleared and wired; deferred
 * ones are registered but stay `tipping_off_reviewed:false` so the gate refuses them
 * until copy has actually been reviewed.
 *
 * Copy rules the review bar enforces: money-outcome and compliance-adjacent templates
 * NEVER name a reason, a hold, or a review — failures read as neutral operational
 * notices (tipping-off / AUSTRAC). Security notices (ownership transfer, recovery hold)
 * DO say what happened: the whole point is that the legitimate owner notices.
 */
export const TEMPLATES = {
  // LIVE — recordAveniaVerdict(approved). Safe copy, reviewed. v2: first-deposit CTA (PRD-14 §5B).
  activation_approved: {
    version: 2,
    locale: "pt-BR",
    subject: "Sua conta Lince está ativa",
    body: "Olá! Sua empresa foi aprovada e sua conta Lince já está ativa. Você já pode começar a operar.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
    cta: { label: "Fazer meu primeiro depósito", path: "/app/deposit" },
  },
  // LIVE — recordAveniaVerdict(rejected). NEUTRAL copy: never names a reason or suspicion.
  application_rejected: {
    version: 1,
    locale: "pt-BR",
    subject: "Atualização sobre sua solicitação",
    body: "Não foi possível concluir sua solicitação no momento. Se precisarmos de algo, nossa equipe entrará em contato.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — createBeneficiaryForOrg.
  beneficiary_added: {
    version: 1,
    locale: "pt-BR",
    subject: "Beneficiário adicionado",
    body: "O beneficiário {{label}} foi cadastrado com sucesso.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — advanceCallerOrg(vendor_pending): the application was forwarded for review.
  application_received: {
    version: 1,
    locale: "pt-BR",
    subject: "Recebemos sua solicitação",
    body: "Sua solicitação de abertura de conta foi recebida e está em análise. Avisaremos assim que houver novidades.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — raiseRfi. NEUTRAL: an information request, never a hint of review depth.
  rfi_requested: {
    version: 1,
    locale: "pt-BR",
    subject: "Ação necessária na sua conta",
    body: "Precisamos de algumas informações adicionais para continuar. Acesse sua conta Lince para ver os detalhes e responder.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — applyTicketStatus on settle. Payload carries a pre-built pt-BR summary line.
  // v2 receipt (PRD-14 phase 1): {{receipt}} = settlement time + itemized vendor fees +
  // effective FX rate, built from ticket actuals at the settle site; empty renders clean.
  ticket_paid: {
    version: 2,
    locale: "pt-BR",
    subject: "Transação concluída",
    body: "{{summary}}\n\n{{receipt}}Você pode ver os detalhes na sua conta Lince.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — applyTicketStatus on failure. NEUTRAL: no reason, ever (tipping-off).
  ticket_failed: {
    version: 1,
    locale: "pt-BR",
    subject: "Atualização sobre uma transação",
    body: "Uma transação não pôde ser concluída e nenhum valor foi debitado do seu saldo. Se precisar de ajuda, fale com nosso suporte.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — transferOwnership (both parties). A security notice: says exactly what happened.
  ownership_transferred: {
    version: 1,
    locale: "pt-BR",
    subject: "A propriedade da conta foi transferida",
    body: "A propriedade da sua empresa na Lince foi transferida de {{fromName}} para {{toName}}. Se você não reconhece esta ação, entre em contato com nosso suporte imediatamente.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // Copy reviewed; trigger lands with Cluster 2 (Clerk recovery signal → registerPostRecoveryHold).
  post_recovery_hold: {
    version: 1,
    locale: "pt-BR",
    subject: "Aviso de segurança na sua conta",
    body: "Sua conta passou por uma recuperação de acesso. Por segurança, envios de dinheiro ficam temporariamente bloqueados por 24 horas. Se você não reconhece esta ação, entre em contato com nosso suporte imediatamente.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — closeOrgForOwner (Cluster 3). Copy per PRD-14 §5D.
  closure_completed: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua conta foi encerrada",
    body: "A conta da {{razaoSocial}} na Lince foi encerrada. Os registros exigidos por lei permanecem guardados pelo prazo legal. Obrigado por ter usado a Lince.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — lifecycle sweep (Cluster 3), stale application at 60d. PRD-14 §5B.
  stale_warning_60d: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua solicitação está parada",
    body: "Sua solicitação de abertura de conta está sem atividade há 60 dias. Para continuar, acesse sua conta e conclua as etapas pendentes.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
    cta: { label: "Continuar minha solicitação", path: "/onboarding" },
  },
  // LIVE — lifecycle sweep, final warning at 80d. PRD-14 §5B.
  stale_warning_80d: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua solicitação expira em breve",
    body: "Sem atividade, sua solicitação de abertura de conta expira em {{daysLeft}} dias. Para continuar de onde parou, acesse sua conta.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
    cta: { label: "Continuar minha solicitação", path: "/onboarding" },
  },
  // LIVE — lifecycle sweep, expiry at 90d (application soft-deleted). PRD-14 §5B.
  application_expired: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua solicitação expirou",
    body: "Sua solicitação de abertura de conta expirou por falta de atividade. Se ainda tiver interesse, você pode iniciar uma nova solicitação quando quiser.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // LIVE — lifecycle sweep, dormant active org. NEUTRAL on purpose: says nothing about
  // reviews or requirements (PRD-14 §5D ⚠).
  dormancy_outreach: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua conta Lince continua disponível",
    body: "Notamos que sua conta está sem movimentação há algum tempo. Ela continua ativa e disponível. Se preferir encerrá-la, você pode fazer isso nas configurações.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
  },
  // ADMIN — generic ops alert (Slack). Exempt from the tipping-off gate; the alert kind
  // rides in the outbox row's event_type and payload.title, detail is pre-serialized.
  admin_alert: {
    version: 1,
    locale: "pt-BR",
    subject: "[Lince] {{title}}",
    body: "{{detail}}",
    tipping_off_reviewed: false, // irrelevant: admin class is exempt
    recipientClass: "admin",
  },
  // DEFERRED (no trigger yet — F2 pre-screen queue is an open register decision).
  returned_to_complete: {
    version: 1,
    locale: "pt-BR",
    subject: "Ação necessária na sua solicitação",
    body: "Precisamos de mais algumas informações para prosseguir.",
    tipping_off_reviewed: false,
    recipientClass: "customer",
  },
} as const satisfies Record<string, Template>;

export type TemplateId = keyof typeof TEMPLATES;

/** Lookup by (possibly unknown) DB string; undefined for an unregistered template_id. */
export function getTemplate(id: string): Template | undefined {
  return (TEMPLATES as Record<string, Template | undefined>)[id];
}

/**
 * Tipping-off gate (acceptance #3). Admin templates always send; a customer/payee
 * template sends only once reviewed. Pure — unit-tested without DB.
 */
export function isSendable(t: Template): boolean {
  return t.recipientClass === "admin" || t.tipping_off_reviewed === true;
}

/**
 * Fill {{var}} placeholders from payload; a missing var renders empty. Pure.
 * With `appBaseUrl` set, customer/payee templates also get the branded HTML part
 * (PRD-14 §3) — the layout wraps the SAME filled text; it never adds words. Admin
 * (Slack) templates and unconfigured environments stay text-only.
 */
export function renderTemplate(
  id: TemplateId,
  payload: Record<string, unknown>,
  appBaseUrl?: string,
): { subject: string; body: string; html?: string } {
  const t: Template = TEMPLATES[id]; // widen: cta is optional and absent on most literals
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(payload[k] ?? ""));
  const subject = fill(t.subject);
  const body = fill(t.body);
  const html =
    appBaseUrl && t.recipientClass !== "admin"
      ? renderEmailHtml({ subject, text: body, appBaseUrl, cta: t.cta })
      : undefined;
  return { subject, body, html };
}
