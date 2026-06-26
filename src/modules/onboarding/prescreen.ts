/**
 * Onboarding pre-screen — COMPLETENESS ONLY (Modelo A).
 *
 * This is NOT a risk/admission decision (admission is Avenia's — see admission.service.ts).
 * It only checks that the minimum fields are present, applies operational re-submission
 * controls (CNPJ denylist + one-live-org-per-CNPJ), and creates the org in
 * `pending_lince_approval`. No KYC PII is stored — the legal rep is operational identity only.
 */
import { withTransaction } from "../../db/pool.js";

export interface PrescreenInput {
  cnpj?: string;
  razaoSocial?: string;
  legalRep?: { fullName?: string; email?: string; phone?: string };
}

export interface PrescreenResult {
  orgId: string;
  state: string;
}

/** Error carrying an HTTP status for the API layer. */
export class PrescreenError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "PrescreenError";
  }
}

export async function prescreenAndCreateOrg(input: PrescreenInput): Promise<PrescreenResult> {
  const cnpj = (input.cnpj ?? "").replace(/\D/g, "");
  const razao = (input.razaoSocial ?? "").trim();
  const rep = input.legalRep ?? {};

  // Completeness only — no risk criteria.
  const missing: string[] = [];
  if (cnpj.length !== 14) missing.push("cnpj");
  if (!razao) missing.push("razaoSocial");
  if (!rep.fullName?.trim()) missing.push("legalRep.fullName");
  if (!rep.email?.trim()) missing.push("legalRep.email");
  if (missing.length) throw new PrescreenError(`incomplete: ${missing.join(", ")}`, 422);

  return withTransaction(async (c) => {
    const deny = await c.query("select 1 from cnpj_denylist where cnpj = $1", [cnpj]);
    if (deny.rowCount) throw new PrescreenError("cnpj_denylisted", 409);

    const dup = await c.query("select 1 from orgs where cnpj = $1 and deleted_at is null", [cnpj]);
    if (dup.rowCount) throw new PrescreenError("cnpj_already_registered", 409);

    const person = await c.query<{ id: string }>(
      `insert into people (full_name, email, phone, can_login) values ($1, $2, $3, true) returning id`,
      [rep.fullName!.trim(), rep.email!.trim(), rep.phone ?? null],
    );
    const personId = person.rows[0]!.id;

    const org = await c.query<{ id: string; state: string }>(
      `insert into orgs (cnpj, razao_social, country_code, state, legal_rep_person_id, onboarding)
       values ($1, $2, 'BR', 'pending_lince_approval', $3, $4)
       returning id, state`,
      [cnpj, razao, personId, JSON.stringify({ submittedAt: new Date().toISOString() })],
    );
    const orgId = org.rows[0]!.id;

    await c.query(
      `insert into org_people (org_id, person_id, roles, status) values ($1, $2, '{owner,legal_rep}', 'active')`,
      [orgId, personId],
    );

    return { orgId, state: org.rows[0]!.state };
  });
}
