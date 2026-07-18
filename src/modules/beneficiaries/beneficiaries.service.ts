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
import { moneyOutHoldActive } from "../access/recoveryHold.js";
import { validateBeneficiary } from "./rails.js";
import { HttpError } from "../../http/error.js";
import type { PayoutRail } from "../providers/avenia/avenia.client.js";

/** The columns a payout needs to validate + forward a payee. */
export interface PayoutBeneficiary {
  id: string;
  rail: string | null;
  status: string;
  label: string;
  asset: string | null; // dest_currency: BRL | USD | EUR | USDT | USDC | ...
  network: string | null; // crypto chain label, else null
  payee_legal_name: string | null;
  payee_country: string | null; // ISO alpha-2 (SEPA: derived from the IBAN prefix at capture)
  destination: Record<string, string> | null;
  avenia_beneficiary_id: string | null;
}

export async function getPayoutBeneficiary(orgId: string, beneficiaryId: string): Promise<PayoutBeneficiary | null> {
  const { rows } = await pool.query<PayoutBeneficiary>(
    `select id, rail, status, label, dest_currency as asset, network, payee_legal_name,
            payee_country, destination, avenia_beneficiary_id
       from avenia_beneficiaries where id = $1 and org_id = $2`,
    [beneficiaryId, orgId],
  );
  return rows[0] ?? null;
}

// Avenia's /eur/ registration wants ISO alpha-3; we store alpha-2 (IBAN prefix). SEPA zone only.
const SEPA_ALPHA3: Record<string, string> = {
  AD: "AND", AT: "AUT", BE: "BEL", BG: "BGR", CH: "CHE", CY: "CYP", CZ: "CZE", DE: "DEU",
  DK: "DNK", EE: "EST", ES: "ESP", FI: "FIN", FR: "FRA", GB: "GBR", GR: "GRC", HR: "HRV",
  HU: "HUN", IE: "IRL", IS: "ISL", IT: "ITA", LI: "LIE", LT: "LTU", LU: "LUX", LV: "LVA",
  MC: "MCO", MT: "MLT", NL: "NLD", NO: "NOR", PL: "POL", PT: "PRT", RO: "ROU", SE: "SWE",
  SI: "SVN", SK: "SVK", SM: "SMR", VA: "VAT",
};

/**
 * Lazily forward a bank-rail payee to Avenia on first use (the "forwarded later" seam from
 * 0004): PIX -> /brl/ with the key, ACH/Fedwire -> /usd/ with the full bank record. Crypto
 * payees are never forwarded (the wallet rides inline in the ticket). Returns the Avenia-side
 * beneficiary id. External call with NO lock held.
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
  const d = beneficiary.destination ?? {};
  let created: { id: string };
  if (beneficiary.rail === "pix") {
    if (!d.pixKey) throw new HttpError("beneficiary_incomplete", 422);
    created = await client.createBrlBeneficiary({ subAccountId, alias: beneficiary.label, pixKey: d.pixKey });
  } else if (beneficiary.rail === "ach" || beneficiary.rail === "fedwire") {
    // Pre-2026-07-15 USD payees miss bankName/address (rails.ts didn't capture them yet):
    // a clean 422 tells the customer to complete the record, never a half-formed registration.
    if (!d.accountNumber || !d.routingNumber || !d.bankName || !d.streetLine1 || !d.city || !d.state || !d.postalCode) {
      throw new HttpError("beneficiary_incomplete", 422);
    }
    created = await client.createUsdBeneficiary({
      subAccountId,
      alias: beneficiary.label,
      bankAccountNumber: d.accountNumber,
      bankRoutingNumber: d.routingNumber,
      bankBeneficiaryName: beneficiary.payee_legal_name ?? beneficiary.label,
      bankName: d.bankName,
      beneficiaryAddress: {
        streetLine1: d.streetLine1,
        ...(d.streetLine2 ? { streetLine2: d.streetLine2 } : {}),
        city: d.city,
        state: d.state,
        postalCode: d.postalCode,
        country: "USA", // ach/fedwire rails are US-fixed (rails.ts)
      },
    });
  } else if (beneficiary.rail === "sepa") {
    const country = SEPA_ALPHA3[beneficiary.payee_country ?? ""];
    if (!d.iban || !country) throw new HttpError("beneficiary_incomplete", 422);
    created = await client.createEurBeneficiary({
      subAccountId,
      alias: beneficiary.label,
      iban: d.iban,
      ...(d.bic ? { bic: d.bic } : {}),
      country,
      bankBeneficiaryName: beneficiary.payee_legal_name ?? beneficiary.label,
    });
  } else {
    throw new HttpError("unsupported_rail", 422); // crypto never registers; swift isn't payable
  }
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
  // Post-recovery hold (Cluster 2): a new payee is the takeover attacker's first move —
  // during the 24h window, adding destinations is blocked along with money-out.
  if (await moneyOutHoldActive(orgId)) throw new HttpError("money_out_held", 403);
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
