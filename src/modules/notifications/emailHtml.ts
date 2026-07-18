/**
 * Branded email base layout (PRD-14 §3). ONE layout wraps every customer/payee email:
 * ink-900 header band with the Lince mark, white card with the reviewed text, footer chrome.
 *
 * THE RULE (PRD-14 §1): the vetted artifact is the PLAIN TEXT. This layer adds chrome
 * (logo, spacing, at most one CTA button) and never adds words beyond the fixed footer.
 * Everything user- or payload-derived is HTML-escaped — a payload variable must never
 * become markup.
 *
 * Light body + dark band on purpose: Gmail/Outlook dark modes invert light backgrounds
 * but leave already-dark elements alone, so the brand anchor survives either way.
 * Email-client reality: tables + inline CSS only, system font stack, no webfonts.
 */

export interface EmailCta {
  label: string;
  path: string; // appended to the configured app base URL
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = "'Segoe UI',system-ui,-apple-system,sans-serif";

/**
 * Render the reviewed text inside the base layout. `appBaseUrl` doubles as the asset
 * base (the customer app hosts /email/lince-mark.png) and the CTA link base.
 */
export function renderEmailHtml(input: {
  subject: string;
  text: string;
  appBaseUrl: string;
  cta?: EmailCta;
}): string {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  const paragraphs = input.text
    .split(/\n\n+/)
    .map((p) => `<p style="margin:0 0 16px;">${esc(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const cta = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;"><tr>
         <td style="background:#f2a93c;border-radius:10px;">
           <a href="${esc(base + input.cta.path)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:700;color:#0e1411;text-decoration:none;">${esc(input.cta.label)}</a>
         </td></tr></table>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${esc(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f1e9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e9;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="background:#0e1411;border-radius:12px 12px 0 0;padding:14px 32px;">
          <img src="${esc(base)}/email/lince-mark.png" width="36" height="36" alt="Lince" style="display:block;border:0;">
        </td></tr>
        <tr><td style="background:#ffffff;padding:32px 32px 16px;font-family:${FONT};font-size:16px;line-height:1.5;color:#0e1411;">
          <p style="margin:0 0 16px;font-size:20px;font-weight:700;">${esc(input.subject)}</p>
          ${paragraphs}${cta}
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:0 0 12px 12px;border-top:1px solid #e8eae6;padding:20px 32px;font-family:${FONT};font-size:12px;line-height:1.6;color:#525b55;">
          Você recebeu este e-mail porque tem uma conta na Lince.<br>
          Precisa de ajuda? Fale com nosso suporte respondendo a este e-mail.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
