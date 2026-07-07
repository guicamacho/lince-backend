/**
 * The Avenia-verdict RELAY action (the operational core of "approve BR manually once
 * Avenia answers").
 *
 * MODELO A — this is NOT a Lince admission decision. Avenia decides out-of-band (the
 * KYB API does not reliably return a verdict). An ops admin records that verdict here.
 * It writes orgs.admission_* with admission_authority_used = 'avenia' + Avenia's ref +
 * the recording admin, and an audit_log entry MARKED AS A RELAY.
 *
 * For BR, admission_authority MUST be 'avenia' — guarded below.
 */
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { enqueueNotification } from "../notifications/outbox.js";

export interface RecordAveniaVerdictInput {
  orgId: string;
  decision: "approved" | "rejected";
  aveniaReference: string;   // Avenia's out-of-band reference for this decision
  recordedByAdminId: string; // admin_users.id of the relaying ops user
  remark?: string;
}

export async function recordAveniaVerdict(input: RecordAveniaVerdictInput): Promise<void> {
  await withTransaction(async (client) => {
    // Guard: only relay where the jurisdiction's admission authority is Avenia (BR).
    const { rows } = await client.query<{ admission_authority: string; admission_state: string }>(
      `select jp.admission_authority, o.admission_state
         from orgs o
         join jurisdiction_policies jp on jp.country_code = o.country_code
        where o.id = $1 and o.deleted_at is null
        for update of o`,
      [input.orgId],
    );
    const authority = rows[0]?.admission_authority;
    if (!authority) throw new Error(`org ${input.orgId} not found`);
    if (authority !== "avenia") {
      // MX/CO (lince/local_partner) use a different path — and are gated on counsel anyway.
      throw new Error(`recordAveniaVerdict is for avenia-admission jurisdictions only (got ${authority})`);
    }
    // CAS under the row lock (pattern 8): relay a verdict ONCE. A second relay (raced or
    // retried) finds admission_state already decided -> a handled 409, never a silent
    // re-write that could flip an approved org to rejected.
    if (rows[0]!.admission_state !== "pending") throw new HttpError("admission_already_recorded", 409);

    const newOrgState = input.decision === "approved" ? "active" : "rejected";
    await client.query(
      `update orgs
          set admission_state = $2,
              admission_authority_used = 'avenia',
              admission_external_ref = $3,
              admission_recorded_by = $4,
              admission_recorded_at = now(),
              state = $5,
              activated_at = case when $2 = 'approved' then now() else activated_at end,
              updated_at = now()
        where id = $1`,
      [input.orgId, input.decision, input.aveniaReference, input.recordedByAdminId, newOrgState],
    );

    // Audit it AS A RELAY — not a Lince decision.
    await client.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'ops', $2, 'admission.avenia_verdict_relayed', $3)`,
      [
        input.orgId,
        input.recordedByAdminId,
        JSON.stringify({
          relay: true,
          decision: input.decision,
          authority: "avenia",
          aveniaReference: input.aveniaReference,
          remark: input.remark ?? null,
        }),
      ],
    );

    if (input.decision === "rejected") {
      // Denylist the CNPJ — reflecting Avenia's decision (operational re-submission control).
      await client.query(
        `insert into cnpj_denylist (cnpj, reason_ref)
         select cnpj, 'avenia_rejection:' || $2 from orgs where id = $1
         on conflict (cnpj) do nothing`,
        [input.orgId, input.aveniaReference],
      );
    }

    // B6: notify the customer in the SAME txn — the row exists iff this verdict commits.
    // ponytail: recipient_ref = org id; resolve to an address at send time when Resend
    //   lands (sending is off in P1, LogAdapter default). Rejection copy is neutral.
    await enqueueNotification(client, {
      eventType: input.decision === "approved" ? "activation_approved" : "application_rejected",
      recipientRef: input.orgId,
      templateId: input.decision === "approved" ? "activation_approved" : "application_rejected",
      payload: { aveniaReference: input.aveniaReference },
    });
  });
}
