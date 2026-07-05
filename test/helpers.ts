/** Test helpers — run against lince_test (DATABASE_URL set by the `test` script). */
import { pool } from "../src/db/pool.js";

// Data tables to clear between tests. Seed tables (jurisdiction_policies, providers,
// provider_currencies) are intentionally NOT truncated.
const DATA_TABLES = [
  "recon_breaks", "recon_runs", "notification_outbox", "rate_limits",
  "audit_log", "cnpj_denylist", "webhook_events",
  "customer_notifications", "case_messages", "cases",
  "ledger_postings", "ledger_transactions", "ledger_accounts", "org_transactions",
  "avenia_beneficiaries", "didit_verifications", "avenia_accounts",
  "org_people", "orgs", "people", "admin_users",
];

export async function resetDb(): Promise<void> {
  await pool.query(`truncate ${DATA_TABLES.join(", ")} restart identity cascade`);
}

export async function createAdmin(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into admin_users (email, name, roles) values ($1, $2, '{compliance}') returning id`,
    [`ops+${Date.now()}-${Math.random()}@lince.test`, "Ops Admin"],
  );
  return rows[0]!.id;
}

export async function createOrg(
  state = "vendor_pending",
  cnpj = `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into orgs (cnpj, razao_social, country_code, state) values ($1, 'Test Ltda', 'BR', $2) returning id`,
    [cnpj, state],
  );
  return rows[0]!.id;
}

export async function insertCase(
  type = "rfi_relay",
  orgId: string | null = null,
  openedBy: string | null = null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into cases (type, org_id, opened_by) values ($1, $2, $3) returning id`,
    [type, orgId, openedBy],
  );
  return rows[0]!.id;
}

export async function createLedgerAccount(
  orgId: string | null,
  currency: string,
  type = "customer_liability",
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ledger_accounts (key, type, org_id, currency) values ($1, $2, $3, $4) returning id`,
    [`acct:${type}:${currency}:${Date.now()}:${Math.random()}`, type, orgId, currency],
  );
  return rows[0]!.id;
}
