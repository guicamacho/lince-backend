/** balanceHistoryForOrg: cumulative per-currency daily series, quiet days carried forward. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTransaction } from "../src/db/pool.js";
import { ensureAccount, postBalancedTransactionOn, balanceHistoryForOrg } from "../src/modules/ledger/ledger.service.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

async function postAt(orgId: string, currency: "BRLA" | "USDT", minor: bigint, daysAgo: number): Promise<void> {
  await withTransaction(async (c) => {
    const custody = await ensureAccount(c, { key: `avenia:custody:${currency}`, type: "vendor_asset", currency });
    const org = await ensureAccount(c, { key: `org:${orgId}:${currency}`, type: "customer_liability", orgId, currency });
    await postBalancedTransactionOn(c, {
      description: "seed",
      postings: [
        { accountId: custody, amount: minor, currency },
        { accountId: org, amount: -minor, currency },
      ],
    });
    // Age BOTH legs so the SP-day bucketing sees the posting on the target day. The ledger is
    // append-only by trigger; disabling triggers via replica role is a TEST-ONLY seam (lince_test).
    await c.query("set local session_replication_role = replica");
    await c.query(
      `update ledger_postings set created_at = now() - make_interval(days => $1)
        where ledger_tx_id = (select id from ledger_transactions order by created_at desc limit 1)`,
      [daysAgo],
    );
    await c.query("set local session_replication_role = origin");
  });
}

test("history: cumulative per currency, gap days carried forward through today", async () => {
  const orgId = await createOrg("active");
  await postAt(orgId, "BRLA", 10_000n, 4); // +R$100 four days ago
  await postAt(orgId, "BRLA", -3_000n, 2); // -R$30 two days ago (payout-shaped delta)
  await postAt(orgId, "USDT", 5_000_000n, 2); // +5 USDT two days ago

  const history = await balanceHistoryForOrg(orgId);
  assert.equal(history.length, 5, "one row per day from first posting through today");

  const byDate = Object.fromEntries(history.map((d) => [d.date, d.balances]));
  const dates = history.map((d) => d.date);
  assert.deepEqual(byDate[dates[0]!], { BRLA: 10_000 }, "day 0: first deposit only");
  assert.deepEqual(byDate[dates[1]!], { BRLA: 10_000 }, "quiet day carries balance forward");
  assert.deepEqual(byDate[dates[2]!], { BRLA: 7_000, USDT: 5_000_000 }, "deltas applied cumulatively");
  assert.deepEqual(history.at(-1)!.balances, { BRLA: 7_000, USDT: 5_000_000 }, "today matches current");
});

test("history: empty ledger -> empty series", async () => {
  const orgId = await createOrg("active");
  assert.deepEqual(await balanceHistoryForOrg(orgId), []);
});
