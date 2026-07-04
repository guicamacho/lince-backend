/**
 * Beneficiaries — travel-rule capture (AUSTRAC §4 / 255033346).
 *
 * The customer captures payee tracing info; Lince retains it and forwards to Avenia
 * later (mocked in P1, so avenia_beneficiary_id stays null). Bodies moved verbatim
 * from the /app/beneficiaries routes — the HTTP contract is unchanged.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { enqueueNotification } from "../notifications/outbox.js";

export async function listBeneficiariesForOrg(orgId: string) {
  const { rows } = await pool.query(
    `select id, label, payee_legal_name, payee_country, payee_bank_psp, payee_account,
            payee_memo, purpose_of_payment, source_of_funds, status, avenia_beneficiary_id, created_at
       from avenia_beneficiaries where org_id = $1 order by created_at desc`,
    [orgId],
  );
  return rows;
}

export async function createBeneficiaryForOrg(
  orgId: string,
  clerkUserId: string | null,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const b = body;
  const required = ["label", "payeeLegalName", "payeeCountry", "payeeBankPsp", "payeeAccount", "purposeOfPayment"] as const;
  for (const k of required) {
    if (!String(b[k] ?? "").trim()) throw new HttpError(`missing_${k}`, 400);
  }
  const account = String(b.payeeAccount).trim();
  // Wrap in a txn so the beneficiary_added notification enqueues atomically with the insert.
  return withTransaction(async (client) => {
    // The authorising individual (org_people) — supports the SMR "who completed it" field.
    const { rows: ap } = await client.query<{ id: string }>(
      `select p.id from people p join org_people op on op.person_id = p.id
        where p.clerk_user_id = $1 and op.org_id = $2 limit 1`,
      [clerkUserId, orgId],
    );
    const { rows } = await client.query<{ id: string }>(
      `insert into avenia_beneficiaries
         (org_id, label, dest_hint, payee_legal_name, payee_country, payee_bank_psp, payee_account,
          payee_memo, purpose_of_payment, source_of_funds, authorised_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        orgId,
        String(b.label).trim(),
        account.slice(-4),
        String(b.payeeLegalName).trim(),
        String(b.payeeCountry).trim(),
        String(b.payeeBankPsp).trim(),
        account,
        b.payeeMemo ? String(b.payeeMemo).trim() : null,
        String(b.purposeOfPayment).trim(),
        b.sourceOfFunds ? String(b.sourceOfFunds).trim() : null,
        ap[0]?.id ?? null,
      ],
    );
    const id = rows[0]!.id;
    // B6: notify the customer in the same txn (ponytail: org id as recipient ref — see outbox).
    await enqueueNotification(client, {
      eventType: "beneficiary_added",
      recipientRef: orgId,
      templateId: "beneficiary_added",
      payload: { label: String(b.label).trim() },
    });
    return { id };
  });
}
