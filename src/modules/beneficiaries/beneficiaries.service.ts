/**
 * Beneficiaries — rail-aware address book + travel-rule capture (AUSTRAC §4 / 255033346).
 *
 * The customer captures a payee on one of several rails (PIX / ACH / Fedwire / SEPA / SWIFT /
 * crypto); rails.validateBeneficiary is the authoritative wall. Lince retains the record and
 * forwards to Avenia later (mocked in P1, so avenia_beneficiary_id stays null). rail = the rail,
 * dest_currency = asset, network = crypto chain, destination = jsonb identifier fields.
 */
import { pool, withTransaction } from "../../db/pool.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  verification_status?: string;
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
            payee_country, destination, avenia_beneficiary_id, verification_status
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
      where id = $1 and avenia_beneficiary_id is null and verification_status <> 'changed_pending'`,
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
          payee_legal_name, payee_country, purpose_of_payment, source_of_funds, authorised_by,
          destination_kind, verification_status, verified_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'verified',now()) returning id`,
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
        RAIL_TO_KIND[v.rail] ?? null,
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

/** destination_kind per rail (0006 CHECK: pix_key|bank_account|iban|wallet|brcode). */
const RAIL_TO_KIND: Record<string, string> = {
  pix: "pix_key",
  ach: "bank_account",
  fedwire: "bank_account",
  sepa: "iban",
  swift: "bank_account",
  crypto: "wallet",
};


/**
 * Edit a payee (PRD-03 §13.2 change control). Two paths:
 *
 *  - LABEL/NAME-ONLY edits: applied in place, audited, verification untouched (the spec's
 *    explicit exclusion).
 *  - DESTINATION edits (any DEST_FIELDS key present): the new destination re-runs the FULL
 *    rails validation wall on the FIXED rail/asset, then the payee resets to
 *    'changed_pending' — NOT payable until an admin re-verifies (operational approval,
 *    PRD-04 §4.5) — with destination_changed_at stamped, verified_at cleared, a MASKED
 *    old→new audit diff (last-4 hints, never full identifiers), the owner notified
 *    (beneficiary_destination_changed, the PRD-03 open-item-#5 channel), and — critical —
 *    avenia_beneficiary_id CLEARED so a later payout re-forwards the NEW destination
 *    instead of paying the stale vendor-side record.
 *
 * Rail and asset are immutable: changing rails is a new payee.
 */
export async function updateBeneficiaryForOrg(
  orgId: string,
  clerkUserId: string | null,
  beneficiaryId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; verificationStatus: string }> {
  if (!UUID_RE.test(beneficiaryId)) throw new HttpError("beneficiary_not_found", 404);
  if (await moneyOutHoldActive(orgId)) throw new HttpError("money_out_held", 403);
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string; label: string; rail: string; dest_currency: string; network: string | null;
      destination: Record<string, string> | null; dest_hint: string | null; payee_legal_name: string | null;
      payee_country: string | null; purpose_of_payment: string | null; source_of_funds: string | null;
      verification_status: string; status: string;
    }>(
      `select id, label, rail, dest_currency, network, destination, dest_hint, payee_legal_name,
              payee_country, purpose_of_payment, source_of_funds, verification_status, status
         from avenia_beneficiaries where id = $1 and org_id = $2 for update`,
      [beneficiaryId, orgId],
    );
    const cur = rows[0];
    if (!cur) throw new HttpError("beneficiary_not_found", 404);
    if (cur.status !== "active") throw new HttpError("beneficiary_disabled", 422);

    const { rows: ap } = await client.query<{ id: string }>(
      `select p.id from people p join org_people op on op.person_id = p.id
        where p.clerk_user_id = $1 and op.org_id = $2 limit 1`,
      [clerkUserId, orgId],
    );
    const actorId = ap[0]?.id ?? null;

    // Create/PATCH share one shape: identifier fields ride under body.destination (rails.ts
    // reads d = body.destination). Its presence — or a crypto network switch — IS the
    // §13.2 destination-change trigger.
    const destinationChanged = body.destination !== undefined || body.network !== undefined;

    if (!destinationChanged) {
      // Name/label-only path — §13.2 exclusion: no verification reset, no notification.
      const label = body.label !== undefined ? String(body.label ?? "").trim() : cur.label;
      const payeeLegalName =
        body.payeeLegalName !== undefined ? String(body.payeeLegalName ?? "").trim() : cur.payee_legal_name;
      if (!label || label.length > 120) throw new HttpError("invalid_label", 422);
      if (!payeeLegalName) throw new HttpError("missing_payeeLegalName", 422);
      await client.query(
        `update avenia_beneficiaries set label = $2, payee_legal_name = $3 where id = $1`,
        [cur.id, label, payeeLegalName],
      );
      await client.query(
        `insert into audit_log (org_id, actor_type, actor_id, event, payload)
         values ($1, 'user', $2, 'beneficiary.updated', $3)`,
        [orgId, actorId, JSON.stringify({ beneficiaryId: cur.id, fields: ["label", "payee_legal_name"] })],
      );
      return { id: cur.id, verificationStatus: cur.verification_status };
    }

    // Destination replacement: re-validate the WHOLE payee shape on the fixed rail. The
    // stored travel-rule fields carry over; the new identifier fields come from the body.
    const v = validateBeneficiary({
      label: body.label !== undefined ? body.label : cur.label,
      rail: cur.rail, // immutable — changing rails is a new payee
      asset: cur.dest_currency,
      network: body.network !== undefined ? body.network : cur.network,
      payeeLegalName: body.payeeLegalName !== undefined ? body.payeeLegalName : cur.payee_legal_name,
      payeeCountry: body.payeeCountry !== undefined ? body.payeeCountry : cur.payee_country,
      purposeOfPayment: cur.purpose_of_payment,
      sourceOfFunds: cur.source_of_funds,
      destination: body.destination !== undefined ? body.destination : cur.destination,
    });

    await client.query(
      `update avenia_beneficiaries
          set label = $2, payee_legal_name = $3, payee_country = $4, network = $5,
              destination = $6, dest_hint = $7, destination_kind = $8,
              verification_status = 'changed_pending', destination_changed_at = now(),
              verified_at = null, avenia_beneficiary_id = null
        where id = $1`,
      [cur.id, v.label, v.payeeLegalName, v.payeeCountry, v.network,
       JSON.stringify(v.destination), v.destHint, RAIL_TO_KIND[cur.rail] ?? null],
    );
    // Masked diff only — full identifiers never reach audit_log (§13.2c). Per-field last-4
    // so a non-primary change (memoTag, bankName, address) still leaves old→new evidence.
    const mask4 = (val: unknown) => (val ? `••${String(val).slice(-4)}` : null);
    const oldDest = cur.destination ?? {};
    const changed = [...new Set([...Object.keys(oldDest), ...Object.keys(v.destination)])]
      .filter((k) => String(oldDest[k] ?? "") !== String(v.destination[k] ?? ""))
      .map((k) => ({ field: k, old: mask4(oldDest[k]), new: mask4(v.destination[k]) }));
    await client.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'user', $2, 'beneficiary.destination_changed', $3)`,
      [orgId, actorId, JSON.stringify({
        beneficiaryId: cur.id,
        rail: cur.rail,
        changed,
        oldHint: cur.dest_hint,
        newHint: v.destHint,
      })],
    );
    await enqueueNotification(client, {
      eventType: "beneficiary_destination_changed",
      recipientRef: orgId,
      templateId: "beneficiary_destination_changed",
      payload: { label: v.label },
    });
    return { id: cur.id, verificationStatus: "changed_pending" };
  });
}

/** Admin re-verification queue (PRD-04 §4.5 operational approval, consumed by §13.2). */
export async function listPendingReverification() {
  const { rows } = await pool.query(
    `select b.id, b.label, b.rail, b.dest_currency as asset, b.dest_hint, b.destination_changed_at,
            b.org_id, o.razao_social
       from avenia_beneficiaries b join orgs o on o.id = b.org_id
      where b.verification_status = 'changed_pending' and o.deleted_at is null
      order by b.destination_changed_at asc`,
  );
  return rows;
}

/** Operational approval: changed_pending -> verified. Payable again; customer notified. */
export async function verifyBeneficiary(beneficiaryId: string, adminId: string): Promise<boolean> {
  if (!UUID_RE.test(beneficiaryId)) return false; // route 409s — same opacity as not-pending
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ org_id: string; label: string }>(
      `update avenia_beneficiaries
          set verification_status = 'verified', verified_at = now()
        where id = $1 and verification_status = 'changed_pending'
        returning org_id, label`,
      [beneficiaryId],
    );
    if (!rows[0]) return false; // not found or not pending — route 409s
    await client.query(
      `insert into audit_log (org_id, actor_type, actor_id, event, payload)
       values ($1, 'ops', $2, 'beneficiary.verified', $3)`,
      [rows[0].org_id, adminId, JSON.stringify({ beneficiaryId })],
    );
    await enqueueNotification(client, {
      eventType: "beneficiary_verified",
      recipientRef: rows[0].org_id,
      templateId: "beneficiary_verified",
      payload: { label: rows[0].label },
    });
    return true;
  });
}
