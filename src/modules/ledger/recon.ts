/**
 * Reconciliation comparator (Completion Register, Cluster 4 — PRD-04 §13.3, PRD-07
 * Pattern 12). The first and only writer of recon_runs / recon_breaks (migration 0005).
 *
 * Two checks per run:
 *   1. SETTLED-POSTINGS MATCH (DB-only): every settled org_transactions row must have its
 *      balanced ledger entry (ledger_transactions.org_transaction_id). A settled ticket
 *      without postings means customer balances lie -> 'missing_posting' break.
 *   2. BALANCE COMPARE (per org subaccount): the org's customer-liability ledger balance
 *      per asset vs Avenia's subaccount balance. IN-FLIGHT TOLERANCE (Pattern 12): an org
 *      with any open money-path row (created/funding/executing/on_hold) is SKIPPED this
 *      run — mid-flight vendor movement vs settle lag is expected, not a break; the org is
 *      compared on a later run once quiet.
 *
 * The MAIN-account custody totals are NOT compared here: avenia:custody:{ccy} equals the
 * sum of org liabilities by double-entry construction, so the per-subaccount compare is
 * the whole signal.
 *
 * Break handling: dedupe against non-resolved breaks of the same (type, subaccount, asset)
 * so a persisting drift raises ONE break, not one per run; each NEW break opens (or reuses)
 * the org's recon_break case and fires enqueueAdminAlert — the 4th Cluster-1 alert site.
 */
import type pg from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { vendorMinor, type Currency } from "../../money/money.js";
import { enqueueAdminAlert } from "../notifications/outbox.js";
import type { BalanceReader } from "../providers/avenia/avenia.client.js";

/** The held assets we reconcile. Fiat legs (BRL/USD/EUR) never rest at Avenia. */
const RECON_ASSETS: Currency[] = ["BRLA", "USDT", "USDC", "EURC"];
// ponytail: caps vendor calls per run; raise (or page) when org count approaches it.
const MAX_ORGS_PER_RUN = 100;

export interface ReconResult {
  runId: string;
  orgsChecked: number;
  skippedInFlight: number;
  vendorErrors: number;
  missingPostings: number;
  balanceDrifts: number;
}

/**
 * Insert a break unless an equivalent one is already open/investigating. Returns true when
 * a NEW break was raised (case + ops alert fire only then).
 */
async function raiseBreak(
  c: pg.PoolClient,
  runId: string,
  orgId: string | null,
  subaccountId: string | null,
  asset: string,
  breakType: "balance_drift" | "missing_posting",
  expectedMinor: bigint,
  actualMinor: bigint | null,
): Promise<boolean> {
  const existing = await c.query(
    `select 1 from recon_breaks
      where break_type = $1 and coalesce(subaccount_id,'') = coalesce($2,'') and coalesce(asset,'') = $3
        and status <> 'resolved' limit 1`,
    [breakType, subaccountId, asset],
  );
  if (existing.rowCount) return false;

  let caseId: string | null = null;
  if (orgId) {
    const open = await c.query<{ id: string }>(
      `select id from cases where org_id = $1 and type = 'recon_break' and status <> 'closed'
        order by opened_at desc limit 1`,
      [orgId],
    );
    caseId =
      open.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `insert into cases (org_id, type, priority, summary)
           values ($1, 'recon_break', 'high', 'Divergência de conciliação') returning id`,
          [orgId],
        )
      ).rows[0]!.id;
  }
  await c.query(
    `insert into recon_breaks (run_id, subaccount_id, asset, break_type, expected_minor, actual_minor, case_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [runId, subaccountId, asset, breakType, expectedMinor, actualMinor, caseId],
  );
  await enqueueAdminAlert(c, "recon_break", {
    runId,
    orgId,
    subaccountId,
    asset,
    breakType,
    expectedMinor: expectedMinor.toString(),
    actualMinor: actualMinor?.toString() ?? null,
    caseId,
  });
  return true;
}

/** One full reconciliation pass. Never throws for a single org's vendor failure. */
export async function runReconOnce(client: BalanceReader): Promise<ReconResult> {
  const run = await pool.query<{ id: string }>(
    `insert into recon_runs (status, scope) values ('running', 'subaccount_balances+settled_postings') returning id`,
  );
  const runId = run.rows[0]!.id;
  const result: ReconResult = {
    runId, orgsChecked: 0, skippedInFlight: 0, vendorErrors: 0, missingPostings: 0, balanceDrifts: 0,
  };

  try {
    // 1 — settled rows with no ledger entry (exactly-once postings failed somewhere).
    await withTransaction(async (c) => {
      const { rows } = await c.query<{ id: string; org_id: string; asset: string; amount: string; subaccount_id: string | null }>(
        `select t.id, t.org_id, coalesce(t.dest_currency, t.source_currency) as asset,
                coalesce(t.dest_amount, t.source_amount) as amount, aa.subaccount_id
           from org_transactions t
           left join avenia_accounts aa on aa.org_id = t.org_id
          where t.state = 'settled'
            and not exists (select 1 from ledger_transactions lt where lt.org_transaction_id = t.id)`,
      );
      for (const r of rows) {
        if (await raiseBreak(c, runId, r.org_id, r.subaccount_id, r.asset, "missing_posting", BigInt(r.amount ?? 0), null)) {
          result.missingPostings++;
        }
      }
    });

    // 2 — per-subaccount balance compare, in-flight tolerant.
    const { rows: orgs } = await pool.query<{ org_id: string; subaccount_id: string }>(
      `select aa.org_id, aa.subaccount_id
         from avenia_accounts aa join orgs o on o.id = aa.org_id
        where aa.subaccount_id is not null and o.deleted_at is null
        order by aa.org_id limit ${MAX_ORGS_PER_RUN + 1}`,
    );
    if (orgs.length > MAX_ORGS_PER_RUN) console.warn("recon.org_cap_hit", { cap: MAX_ORGS_PER_RUN });

    for (const org of orgs.slice(0, MAX_ORGS_PER_RUN)) {
      const inFlight = await pool.query(
        `select 1 from org_transactions
          where org_id = $1 and state in ('created','funding','executing','on_hold') limit 1`,
        [org.org_id],
      );
      if (inFlight.rowCount) {
        result.skippedInFlight++;
        continue;
      }
      let vendor: Record<string, string>;
      try {
        vendor = await client.getBalances(org.subaccount_id);
      } catch (e) {
        result.vendorErrors++;
        console.warn("recon.vendor_read_failed", { orgId: org.org_id, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const { rows: ledger } = await pool.query<{ currency: string; liability: string }>(
        `select a.currency, coalesce(-sum(p.amount), 0) as liability
           from ledger_accounts a left join ledger_postings p on p.account_id = a.id
          where a.org_id = $1 and a.type = 'customer_liability'
          group by a.currency`,
        [org.org_id],
      );
      const ledgerByCcy = new Map(ledger.map((l) => [l.currency, BigInt(l.liability)]));
      await withTransaction(async (c) => {
        for (const asset of RECON_ASSETS) {
          const expected = ledgerByCcy.get(asset) ?? 0n;
          const actual = vendorMinor(String(vendor[asset] ?? "0"), asset);
          if (expected !== actual) {
            if (await raiseBreak(c, runId, org.org_id, org.subaccount_id, asset, "balance_drift", expected, actual)) {
              result.balanceDrifts++;
            }
          }
        }
      });
      result.orgsChecked++;
    }

    await pool.query(
      `update recon_runs set status = 'completed', finished_at = now(), summary = $2 where id = $1`,
      [runId, JSON.stringify(result)],
    );
  } catch (e) {
    await pool.query(
      `update recon_runs set status = 'failed', finished_at = now(), summary = $2 where id = $1`,
      [runId, JSON.stringify({ ...result, error: e instanceof Error ? e.message : String(e) })],
    );
    throw e;
  }
  return result;
}
