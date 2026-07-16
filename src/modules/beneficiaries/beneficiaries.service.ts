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
import type { PayoutRail } from "../providers/avenia/avenia.client.js";

/** The columns a payout needs to validate + forward a payee. */
export interface PayoutBeneficiary {
  id: string;
  rail: string | null;
  status: string;
  label: string;
  destination: { pixKey?: string } | null;
  avenia_beneficiary_id: string | null;
}

export async function getPayoutBeneficiary(orgId: string, beneficiaryId: string): Promise<PayoutBeneficiary | null> {
  const { rows } = await pool.query<PayoutBeneficiary>(
    `select id, rail, status, label, destination, avenia_beneficiary_id
       from avenia_beneficiaries where id = $1 and org_id = $2`,
    [beneficiaryId, orgId],
  );
  return rows[0] ?? null;
}

/**
 * Lazily forward a PIX payee to Avenia on first use (the "forwarded later" seam from 0004).
 * Returns the Avenia-side beneficiaryBrlBankAccountId. External call with NO lock held.
 * ponytail: no claim row — two racing first-payouts may both register at Avenia; first UPDATE
 * wins here and the loser's vendor record sits orphaned at Avenia (cosmetic; deletable). Add
 * the avenia_accounts-style claim if orphans ever matter.
 */
export async function ensureAveniaBeneficiary(
  orgId: string,
  beneficiary: PayoutBeneficiary,
  subAccountId: string,
  client: PayoutRail,
): Promise<string> {
  if (beneficiary.avenia_beneficiary_id) return beneficiary.avenia_beneficiary_id;
  const pixKey = beneficiary.destination?.pixKey;
  if (!pixKey) throw new Error("beneficiary has no pixKey"); // rail gate upstream makes this unreachable
  const created = await client.createBrlBeneficiary({ subAccountId, alias: beneficiary.label, pixKey });
  const upd = await pool.query(
    `update avenia_beneficiaries set avenia_beneficiary_id = $2
      where id = $1 and avenia_beneficiary_id is null`,
    [beneficiary.id, created.id],
  );
  if (!upd.rowCount) {
    // A concurrent forward won the write — use the stored id, not ours.
    const { rows } = await pool.query<{ avenia_beneficiary_id: string }>(
      "select avenia_beneficiary_id from avenia_beneficiaries where id = $1",
      [beneficiary.id],
    );
    return rows[0]!.avenia_beneficiary_id;
  }
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, 'system', null, 'avenia.beneficiary_forwarded', $2)`,
    [orgId, JSON.stringify({ beneficiaryId: beneficiary.id, aveniaBeneficiaryId: created.id })],
  );
  return created.id;
}

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
