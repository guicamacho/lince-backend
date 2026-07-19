/**
 * Org bootstrap on (customer) signup.
 *
 * Ensures a `people` row for the Clerk user, then creates the org in
 * `pending_lince_approval` + the owner `org_people` link. Captures company
 * CNPJ + razão social + the rep's role. **NO CPF / no KYC PII** (Modelo A —
 * identity capture is Didit's, forwarded to Avenia).
 *
 * Idempotent: if this Clerk user already has a live org, returns it (the customer
 * app may call this more than once around signup).
 */
import { pool, withTransaction } from "../../db/pool.js";
import { lookupCnpj } from "./cnpjLookup.js";
import { acquireOrgOnboardingLock } from "../../db/lockKeys.js";
import { HttpError } from "../../http/error.js";
import { CONSENT_VERSIONS, type ConsentVersions } from "./consent.js";

// unique_violation on the CNPJ partial-unique index (orgs_cnpj_active_uq, migration 0010).
function isCnpjConflict(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null &&
    (e as { code?: string }).code === "23505" &&
    (e as { constraint?: string }).constraint === "orgs_cnpj_active_uq"
  );
}

export interface BootstrapInput {
  cnpj?: string;
  razaoSocial?: string;
  role?: string; // the legal rep's job title (e.g. "CEO") — NOT an RBAC role
  fullName?: string;
  email?: string;
  // Versioned ToS acceptance captured on the signup form; server defaults to the
  // current CONSENT_VERSIONS if omitted. Recorded once per org (see step 4).
  consent?: ConsentVersions;
}

export interface BootstrapResult {
  orgId: string;
  state: string;
}

export async function bootstrapOrgForClerkUser(clerkUserId: string, input: BootstrapInput,
  checkCnpj?: ((clerkUserId: string, cnpj: string) => Promise<{ ativa: boolean }>) | null): Promise<BootstrapResult> {
  const cnpj = (input.cnpj ?? "").replace(/\D/g, "");
  const razao = (input.razaoSocial ?? "").trim();
  const fullName = (input.fullName ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const role = (input.role ?? "").trim();

  // Completeness only — no risk criteria (admission is Avenia's).
  const missing: string[] = [];
  if (cnpj.length !== 14) missing.push("cnpj");
  if (!razao) missing.push("razaoSocial");
  if (!fullName) missing.push("fullName");
  if (!email) missing.push("email");
  if (missing.length) throw new HttpError(`incomplete: ${missing.join(", ")}`, 422);

  // PRD-01 AC-1: server-side ATIVA check (completeness, not risk — situação cadastral is a
  // Receita fact). FAIL-OPEN on registry outage: a BrasilAPI 5xx must never block signups;
  // the attestation records whether the check ran. cnpj_not_found/invalid still reject.
  // Injectable for tests; under NODE_ENV=test the default is OFF (no live BrasilAPI calls
  // from the suite — same guard pattern as the server listen).
  let situacaoChecked = false;
  const check = checkCnpj ?? (process.env.NODE_ENV === "test" ? null : lookupCnpj);
  // Idempotent re-calls (double-click, client retry) must return the existing org, never
  // re-consult the registry — a transient BrasilAPI 404 or situação drift would otherwise
  // fail a signup that already succeeded. TOCTOU here is harmless: the tx short-circuit
  // below is authoritative.
  const { rows: existing } = await pool.query(
    `select 1 from people p join org_people op on op.person_id = p.id
      where p.clerk_user_id = $1 limit 1`,
    [clerkUserId],
  );
  if (check && !existing.length) {
    try {
      const reg = await check(clerkUserId, cnpj);
      situacaoChecked = true;
      if (!reg.ativa) throw new HttpError("cnpj_not_ativa", 422);
    } catch (e) {
      if (e instanceof HttpError && e.message === "cnpj_lookup_unavailable") {
        situacaoChecked = false; // outage — proceed, attest unchecked
      } else {
        throw e;
      }
    }
  }

  return withTransaction(async (c) => {
    // Serialize concurrent signups for the same company (pattern 9). Keyed on the CNPJ
    // because the org has no id yet; orgs_cnpj_active_uq is the DB backstop. Advisory lock
    // FIRST, before any row locks (lock-ordering invariant).
    await acquireOrgOnboardingLock(c, cnpj);

    // 1) person for this Clerk user: already linked, else attach to a matching
    //    login-person by email, else create a new login person.
    const linked = await c.query<{ id: string }>("select id from people where clerk_user_id = $1", [clerkUserId]);
    let personId = linked.rows[0]?.id;
    if (!personId) {
      const byEmail = await c.query<{ id: string }>(
        "select id from people where lower(email) = $1 and can_login = true and clerk_user_id is null limit 1",
        [email],
      );
      if (byEmail.rows[0]) {
        await c.query("update people set clerk_user_id = $2, full_name = $3, updated_at = now() where id = $1", [
          byEmail.rows[0].id,
          clerkUserId,
          fullName,
        ]);
        personId = byEmail.rows[0].id;
      } else {
        const created = await c.query<{ id: string }>(
          "insert into people (clerk_user_id, full_name, email, can_login) values ($1,$2,$3,true) returning id",
          [clerkUserId, fullName, email],
        );
        personId = created.rows[0]!.id;
      }
    }

    // 2) idempotent: one org per signup — if the user already has one, return it.
    const existing = await c.query<{ id: string; state: string }>(
      `select o.id, o.state from org_people op join orgs o on o.id = op.org_id
        where op.person_id = $1 and o.deleted_at is null order by o.created_at asc limit 1`,
      [personId],
    );
    if (existing.rows[0]) return { orgId: existing.rows[0].id, state: existing.rows[0].state };

    // 3) operational re-submission control: denylist stays a check (a separate table).
    const deny = await c.query("select 1 from cnpj_denylist where cnpj = $1", [cnpj]);
    if (deny.rowCount) throw new HttpError("cnpj_denylisted", 409);

    // 4) org (pending) + owner link. Insert-first against orgs_cnpj_active_uq (pattern 9):
    //    a same-CNPJ duplicate loses on the unique index and routes to the existing 409 —
    //    no check-then-insert TOCTOU. The onboarding lock above already serialises the race.
    let orgRow: { id: string; state: string };
    try {
      const inserted = await c.query<{ id: string; state: string }>(
        `insert into orgs (cnpj, razao_social, country_code, state, legal_rep_person_id, onboarding)
         values ($1,$2,'BR','pending_lince_approval',$3,$4) returning id, state`,
        [cnpj, razao, personId, JSON.stringify({ role: role || null, submittedAt: new Date().toISOString() })],
      );
      orgRow = inserted.rows[0]!;
    } catch (e) {
      if (isCnpjConflict(e)) throw new HttpError("cnpj_already_registered", 409);
      throw e;
    }
    await c.query(
      `insert into org_people (org_id, person_id, roles, status) values ($1,$2,'{owner,legal_rep}','active')`,
      [orgRow.id, personId],
    );

    // PRD-01 AC-1 attestation: record that the situação-cadastral check ran (or that the
    // registry was down and signup proceeded fail-open). Rejections never reach here.
    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'system', null, 'signup.cnpj_situacao_checked', $2)`,
      [orgRow.id, JSON.stringify({ checked: situacaoChecked, ativa: situacaoChecked ? true : null, source: "brasilapi" })],
    );

    // Versioned ToS-acceptance event — once per org (this branch only runs when a new
    // org is created; idempotent re-calls short-circuit at step 2). Records who/when/
    // which-version-of-each (PRD-02 AC-17). Client-supplied versions or the current set.
    const consent = input.consent ?? CONSENT_VERSIONS;
    await c.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'user', $2, 'consent.accepted', $3)`,
      [
        orgRow.id,
        personId,
        JSON.stringify({
          documents: [
            { id: "avenia_terms", version: consent.avenia_terms },
            { id: "lince_channel_terms", version: consent.lince_channel_terms },
            { id: "lgpd_consent", version: consent.lgpd_consent },
          ],
          acceptedAt: new Date().toISOString(),
        }),
      ],
    );
    return { orgId: orgRow.id, state: orgRow.state };
  });
}
