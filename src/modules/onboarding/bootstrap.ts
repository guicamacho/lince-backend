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
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

export interface BootstrapInput {
  cnpj?: string;
  razaoSocial?: string;
  role?: string; // the legal rep's job title (e.g. "CEO") — NOT an RBAC role
  fullName?: string;
  email?: string;
}

export interface BootstrapResult {
  orgId: string;
  state: string;
}

export async function bootstrapOrgForClerkUser(clerkUserId: string, input: BootstrapInput): Promise<BootstrapResult> {
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

  return withTransaction(async (c) => {
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

    // 3) operational re-submission controls.
    const deny = await c.query("select 1 from cnpj_denylist where cnpj = $1", [cnpj]);
    if (deny.rowCount) throw new HttpError("cnpj_denylisted", 409);
    const dup = await c.query("select 1 from orgs where cnpj = $1 and deleted_at is null", [cnpj]);
    if (dup.rowCount) throw new HttpError("cnpj_already_registered", 409);

    // 4) org (pending) + owner link.
    const org = await c.query<{ id: string; state: string }>(
      `insert into orgs (cnpj, razao_social, country_code, state, legal_rep_person_id, onboarding)
       values ($1,$2,'BR','pending_lince_approval',$3,$4) returning id, state`,
      [cnpj, razao, personId, JSON.stringify({ role: role || null, submittedAt: new Date().toISOString() })],
    );
    await c.query(
      `insert into org_people (org_id, person_id, roles, status) values ($1,$2,'{owner,legal_rep}','active')`,
      [org.rows[0]!.id, personId],
    );
    return { orgId: org.rows[0]!.id, state: org.rows[0]!.state };
  });
}
