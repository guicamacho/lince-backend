/**
 * Server-side CNPJ lookup (public Receita data via BrasilAPI) to pre-fill onboarding.
 *
 * Backend home for what the customer app did inline: normalize -> fetch razão social
 * + situação. Modelo A: public company data only, no KYC PII at rest — nothing here is
 * persisted. Errors are thrown as HttpError so app.ts maps them; the route (Wave 2)
 * translates codes to neutral pt-BR strings. Per-user throttling now lives in the
 * shared rateLimit("cnpj_lookup") middleware (WP-B13), not in-process here.
 */
import { HttpError } from "../../http/error.js";

export interface CnpjLookupResult {
  razaoSocial: string;
  ativa: boolean;
}

/** Digits-only 14-length CNPJ, else cnpj_invalid. */
export function normalizeCnpj(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length !== 14) throw new HttpError("cnpj_invalid", 422);
  return digits;
}

interface CnpjResponse {
  razao_social?: unknown;
  descricao_situacao_cadastral?: unknown;
  situacao_cadastral?: unknown;
}

/** Map BrasilAPI's payload; empty razão social throws cnpj_no_name. */
export function mapCnpjResponse(data: CnpjResponse): CnpjLookupResult {
  const razaoSocial = String(data.razao_social ?? "").trim();
  if (!razaoSocial) throw new HttpError("cnpj_no_name", 422);
  // ponytail: BrasilAPI returns both a code (2 = ATIVA) and a label — accept either.
  const ativa = data.descricao_situacao_cadastral === "ATIVA" || data.situacao_cadastral === 2;
  return { razaoSocial, ativa };
}

// clerkUserId is retained for the route signature (app.ts) — throttling is now the
// rateLimit("cnpj_lookup") middleware's job, so it is no longer read here.
export async function lookupCnpj(clerkUserId: string, rawCnpj: string): Promise<CnpjLookupResult> {
  void clerkUserId;
  const digits = normalizeCnpj(rawCnpj);

  let data: CnpjResponse;
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      // Cloudflare 403s the default undici User-Agent — any UA gets through.
      headers: { "User-Agent": "lince-finance", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) throw new HttpError("cnpj_not_found", 404);
    if (!res.ok) throw new HttpError("cnpj_lookup_unavailable", 502);
    data = (await res.json()) as CnpjResponse;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError("cnpj_lookup_unavailable", 502); // network / timeout / parse
  }
  return mapCnpjResponse(data);
}
