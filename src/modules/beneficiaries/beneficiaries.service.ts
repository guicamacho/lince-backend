/**
 * Beneficiaries — rail-aware address book + travel-rule capture (AUSTRAC §4 / 255033346).
 *
 * The customer captures a payee on one of several rails (PIX / ACH / Fedwire / SEPA / SWIFT /
 * crypto); rails.validateBeneficiary is the authoritative wall. Lince retains the record and
 * forwards to Avenia later (mocked in P1, so avenia_beneficiary_id stays null). rail = the rail,
 * dest_currency = asset, network = crypto chain, destination = jsonb identifier fields.
 */
import { pool, withTransaction } from "../../db/pool.js";
import { enqueueNotification } from "../notifications/outbox.js";
import { validateBeneficiary } from "./rails.js";

export async function listBeneficiariesForOrg(orgId: string) {
  const { rows } = await pool.query(
    `select id, label, rail, dest_currency as asset, network, dest_hint,
            payee_legal_name, payee_country, purpose_of_payment, verification_status, status, created_at
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
  const v = validateBeneficiary(body); // throws HttpError on any invalid/missing rail field
  return withTransaction(async (client) => {
    // The authorising individual (org_people) — supports the SMR "who completed it" field.
    const { rows: ap } = await client.query<{ id: string }>(
      `select p.id from people p join org_people op on op.person_id = p.id
        where p.clerk_user_id = $1 and op.org_id = $2 limit 1`,
      [clerkUserId, orgId],
    );
    const { rows } = await client.query<{ id: string }>(
      `insert into avenia_beneficiaries
         (org_id, label, rail, dest_currency, network, destination, dest_hint,
          payee_legal_name, payee_country, purpose_of_payment, source_of_funds, authorised_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        orgId,
        v.label,
        v.rail,
        v.asset,
        v.network,
        JSON.stringify(v.destination),
        v.destHint,
        v.payeeLegalName,
        v.payeeCountry,
        v.purposeOfPayment,
        v.sourceOfFunds,
        ap[0]?.id ?? null,
      ],
    );
    const id = rows[0]!.id;
    // B6: notify the customer in the same txn (ponytail: org id as recipient ref — see outbox).
    await enqueueNotification(client, {
      eventType: "beneficiary_added",
      recipientRef: orgId,
      templateId: "beneficiary_added",
      payload: { label: v.label },
    });
    return { id };
  });
}
