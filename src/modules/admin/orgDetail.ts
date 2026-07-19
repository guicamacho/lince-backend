/**
 * Org 360 read (A2). A single org's operational picture for the admin detail view:
 * lifecycle + access seam, the admission record (with submitted-at + live elapsed while
 * pending), the Avenia/Didit reference+status blocks (NO PII), the operational team
 * (org_people ⋈ people), and the last 50 audit rows (the "Status History" primitive).
 *
 * Modelo A: references + status only. Read-only, NOT audited (a plain read, not a reveal).
 */
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

export interface OrgDetail {
  org: Record<string, unknown>;
  admission: {
    authority_used: string | null;
    external_ref: string | null;
    recorded_by_name: string | null;
    recorded_at: Date | null;
    submitted_at: Date | null;
    elapsed_seconds: number | null;
  };
  avenia: Record<string, unknown> | null;
  didit: { status: string; decision_ref: string | null } | null;
  people: Array<{ full_name: string; email: string; roles: string[]; status: string }>;
  audit: Array<{ event: string; actor_type: string; actor_id: string | null; payload: unknown; created_at: Date }>;
}

export async function getOrgDetail(orgId: string): Promise<OrgDetail> {
  const org = await pool.query(
    `select o.id, '••••••••••' || right(o.cnpj, 4) as cnpj, o.razao_social, o.country_code, o.state, o.admission_state,
            o.access_status, o.access_reason, o.access_source, o.access_changed_at,
            o.kyb_forwarded_at, o.activated_at, o.created_at,
            o.admission_authority_used, o.admission_external_ref, o.admission_recorded_at,
            au.name as recorded_by_name,
            case when o.admission_recorded_at is null and o.kyb_forwarded_at is not null
                 then extract(epoch from (now() - o.kyb_forwarded_at))::float8 end as elapsed_seconds
       from orgs o
       left join admin_users au on au.id = o.admission_recorded_by
      where o.id = $1 and o.deleted_at is null`,
    [orgId],
  );
  const r = org.rows[0] as Record<string, unknown> | undefined;
  if (!r) throw new HttpError("org_not_found", 404);

  const [avenia, didit, people, audit] = await Promise.all([
    pool.query(
      `select subaccount_id, kyb_l1_state, pofc_state, usd_state, eur_state
         from avenia_accounts where org_id = $1`,
      [orgId],
    ),
    pool.query<{ status: string; decision_ref: string | null }>(
      `select status, decision_ref from didit_verifications
        where org_id = $1 order by created_at desc limit 1`,
      [orgId],
    ),
    pool.query<{ full_name: string; email: string; roles: string[]; status: string }>(
      `select p.full_name, p.email, op.roles, op.status
         from org_people op join people p on p.id = op.person_id
        where op.org_id = $1 order by op.created_at asc`,
      [orgId],
    ),
    pool.query<{ event: string; actor_type: string; actor_id: string | null; payload: unknown; created_at: Date }>(
      `select event, actor_type, actor_id, payload, created_at
         from audit_log where org_id = $1 order by created_at desc limit 50`,
      [orgId],
    ),
  ]);

  return {
    org: {
      id: r.id, cnpj: r.cnpj, razao_social: r.razao_social, country_code: r.country_code,
      state: r.state, admission_state: r.admission_state, access_status: r.access_status,
      access_reason: r.access_reason, access_source: r.access_source, access_changed_at: r.access_changed_at,
      kyb_forwarded_at: r.kyb_forwarded_at, activated_at: r.activated_at, created_at: r.created_at,
    },
    admission: {
      authority_used: (r.admission_authority_used ?? null) as string | null,
      external_ref: (r.admission_external_ref ?? null) as string | null,
      recorded_by_name: (r.recorded_by_name ?? null) as string | null,
      recorded_at: (r.admission_recorded_at ?? null) as Date | null,
      submitted_at: (r.kyb_forwarded_at ?? null) as Date | null,
      elapsed_seconds: (r.elapsed_seconds ?? null) as number | null,
    },
    avenia: avenia.rows[0] ?? null,
    didit: didit.rows[0] ?? null,
    people: people.rows,
    audit: audit.rows,
  };
}
