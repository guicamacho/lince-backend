/**
 * Avenia COMPANY subaccount per customer org (Connectivity §3): created when a B2B
 * customer starts verification — the subaccount must exist BEFORE KYB runs against it.
 * The Avenia id lands on avenia_accounts.subaccount_id (refs only, no PII).
 *
 * Concurrency: the external Avenia call runs with NO db lock held (lock-ordering
 * invariant, see lockKeys.ts). Instead a claim row serialises creators: the first
 * caller inserts the avenia_accounts row (PK org_id) and owns provisioning; a
 * concurrent caller sees the unfilled claim and gets a retryable 409. On Avenia
 * failure the claim is released so the customer's retry works.
 * ponytail: a process crash mid-call leaves an unfilled claim that needs a manual
 * release (delete the row); add age-based takeover if that ever actually bites.
 */
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import type { SubAccountCreator, AccountInfoReader } from "../providers/avenia/avenia.client.js";

/** Idempotent: returns the org's subaccount id, creating it on Avenia if needed.
 *  Returns null when Avenia is not configured in this environment (keyless dev/tests). */
export async function ensureAveniaSubaccount(orgId: string, client: SubAccountCreator | null): Promise<string | null> {
  if (!client) return null;

  const claim = await pool.query(
    "insert into avenia_accounts (org_id) values ($1) on conflict (org_id) do nothing returning org_id",
    [orgId],
  );
  if (!claim.rowCount) {
    const { rows } = await pool.query<{ subaccount_id: string | null }>(
      "select subaccount_id from avenia_accounts where org_id = $1",
      [orgId],
    );
    if (rows[0]?.subaccount_id) return rows[0].subaccount_id;
    throw new HttpError("avenia_provisioning_in_progress", 409);
  }

  // We own the claim. Create on Avenia (named after the org), then fill the row.
  const org = await pool.query<{ razao_social: string }>("select razao_social from orgs where id = $1", [orgId]);
  if (!org.rows[0]) {
    await releaseClaim(orgId);
    throw new HttpError("org_not_found", 404);
  }
  let sub: { id: string };
  try {
    sub = await client.createSubAccount(org.rows[0].razao_social);
  } catch {
    await releaseClaim(orgId); // nothing was created — let the customer retry
    throw new HttpError("verification_unavailable", 502);
  }
  await pool.query("update avenia_accounts set subaccount_id = $2 where org_id = $1", [orgId, sub.id]);
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload)
     values ($1, 'system', null, 'avenia.subaccount_created', $2)`,
    [orgId, JSON.stringify({ subaccountId: sub.id })],
  );
  return sub.id;
}

async function releaseClaim(orgId: string): Promise<void> {
  await pool.query("delete from avenia_accounts where org_id = $1 and subaccount_id is null", [orgId]);
}

export interface DepositDetails {
  pixKey: string | null;
  brCode: string | null;
  wallets: Array<{ chain: string; address: string }>;
}

/** Deposit details for an APPROVED org (the /app gate enforces active status).
 *  Lazily provisions the subaccount for orgs approved before provisioning shipped.
 *  NOTE: pre-KYB, Avenia returns the MASTER account's pixKey/brCode for a subaccount
 *  (verified 2026-07-07) — per-customer deposit routing uses per-ticket brCodes until
 *  subaccount KYB L1 lands; this endpoint surfaces what Avenia reports for the org. */
export async function depositDetailsForOrg(
  orgId: string,
  client: (SubAccountCreator & AccountInfoReader) | null,
): Promise<DepositDetails> {
  if (!client) throw new HttpError("avenia_unavailable", 503);
  const { rows } = await pool.query<{ subaccount_id: string | null }>(
    "select subaccount_id from avenia_accounts where org_id = $1",
    [orgId],
  );
  const sub = rows[0]?.subaccount_id ?? (await ensureAveniaSubaccount(orgId, client));
  let info;
  try {
    info = await client.getAccountInfo(sub ?? undefined);
  } catch {
    throw new HttpError("avenia_unavailable", 502);
  }
  return {
    pixKey: info.pixKey ?? null,
    brCode: info.brCode ?? null,
    wallets: (info.wallets ?? []).map((w) => ({ chain: w.chain, address: w.walletAddress })),
  };
}
