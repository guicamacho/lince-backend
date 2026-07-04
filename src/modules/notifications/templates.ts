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

export type RecipientClass = "customer" | "admin" | "payee";

export interface Template {
  version: number;
  locale: "pt-BR";
  subject: string;
  body: string; // {{var}} placeholders filled from the outbox row payload
  tipping_off_reviewed: boolean;
  recipientClass: RecipientClass;
}

/**
 * v1 registry. Only templates with a LIVE enqueue site this session are review-cleared
 * and wired; deferred ones are registered but stay `tipping_off_reviewed:false` so the
 * gate refuses them until copy has actually been reviewed.
 * ponytail: registering only the live 3 + one deferred fixture; add the rest
 *   (rfi_requested, ticket_paid/failed, reversal_credited, …) when their triggers land.
 */
export const TEMPLATES = {
  // LIVE — recordAveniaVerdict(approved). Safe copy, reviewed.
  activation_approved: {
    version: 1,
    locale: "pt-BR",
    subject: "Sua conta Lince está ativa",
    body: "Olá! Sua empresa foi aprovada e sua conta Lince já está ativa. Você já pode começar a operar.",
    tipping_off_reviewed: true,
    recipientClass: "customer",
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
  // DEFERRED (no trigger yet) — registered but NOT review-cleared; the gate refuses it.
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

/** Fill {{var}} placeholders from payload; a missing var renders empty. Pure. */
export function renderTemplate(id: TemplateId, payload: Record<string, unknown>): { subject: string; body: string } {
  const t = TEMPLATES[id];
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(payload[k] ?? ""));
  return { subject: fill(t.subject), body: fill(t.body) };
}
