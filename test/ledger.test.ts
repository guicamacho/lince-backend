import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool, withTransaction } from "../src/db/pool.js";
import { postBalancedTransaction, balanceOf } from "../src/modules/ledger/ledger.service.js";
import { DuplicateLedgerPostError } from "../src/modules/ledger/ledger.types.js";
import { resetDb, createLedgerAccount } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("idempotencyKey backstop: a second post with the same key throws, no double credit", async () => {
  const a = await createLedgerAccount(null, "BRL", "customer_liability");
  const b = await createLedgerAccount(null, "BRL", "vendor_asset");
  const post = () =>
    postBalancedTransaction({
      description: "settle",
      idempotencyKey: "deposit-settle:tx-1",
      postings: [
        { accountId: a, amount: -10_000n, currency: "BRL" },
        { accountId: b, amount: 10_000n, currency: "BRL" },
      ],
    });
  await post();
  await assert.rejects(post, (e) => e instanceof DuplicateLedgerPostError);
  assert.equal(await balanceOf(b, "BRL"), 10_000n); // credited exactly once
});

test("balanced commit; balance = SUM(postings)", async () => {
  const a = await createLedgerAccount(null, "BRL", "customer_liability");
  const b = await createLedgerAccount(null, "BRL", "vendor_asset");
  await postBalancedTransaction({
    description: "deposit",
    postings: [
      { accountId: a, amount: -10_000n, currency: "BRL" },
      { accountId: b, amount: 10_000n, currency: "BRL" },
    ],
  });
  assert.equal(await balanceOf(a, "BRL"), -10_000n);
  assert.equal(await balanceOf(b, "BRL"), 10_000n);
});

test("app-level check rejects an unbalanced transaction", async () => {
  const a = await createLedgerAccount(null, "BRL");
  const b = await createLedgerAccount(null, "BRL");
  await assert.rejects(
    postBalancedTransaction({
      description: "bad",
      postings: [
        { accountId: a, amount: -10_000n, currency: "BRL" },
        { accountId: b, amount: 9_999n, currency: "BRL" },
      ],
    }),
  );
});

test("DB trigger rejects an unbalanced commit (bypassing the app check)", async () => {
  const a = await createLedgerAccount(null, "BRL");
  const b = await createLedgerAccount(null, "BRL");
  await assert.rejects(
    withTransaction(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "insert into ledger_transactions (description) values ('raw') returning id",
      );
      const tx = rows[0]!.id;
      await c.query("insert into ledger_postings (ledger_tx_id, account_id, amount, currency) values ($1,$2,'-100','BRL')", [tx, a]);
      await c.query("insert into ledger_postings (ledger_tx_id, account_id, amount, currency) values ($1,$2,'50','BRL')", [tx, b]);
    }),
  );
});

test("postings/transactions are append-only", async () => {
  const a = await createLedgerAccount(null, "BRL");
  const b = await createLedgerAccount(null, "BRL");
  await postBalancedTransaction({
    description: "x",
    postings: [
      { accountId: a, amount: -100n, currency: "BRL" },
      { accountId: b, amount: 100n, currency: "BRL" },
    ],
  });
  await assert.rejects(pool.query("update ledger_postings set amount = 0"));
  await assert.rejects(pool.query("delete from ledger_postings"));
});

test("multi-currency transaction nets to zero per currency", async () => {
  const brl = await createLedgerAccount(null, "BRL");
  const brl2 = await createLedgerAccount(null, "BRL");
  const usd = await createLedgerAccount(null, "USD");
  const usd2 = await createLedgerAccount(null, "USD");
  await postBalancedTransaction({
    description: "convert",
    postings: [
      { accountId: brl, amount: -10_000n, currency: "BRL" },
      { accountId: brl2, amount: 10_000n, currency: "BRL" },
      { accountId: usd, amount: -2_000n, currency: "USD" },
      { accountId: usd2, amount: 2_000n, currency: "USD" },
    ],
  });
  assert.equal(await balanceOf(brl, "BRL"), -10_000n);
  assert.equal(await balanceOf(usd2, "USD"), 2_000n);
});
