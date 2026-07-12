/** FX rate board (Início Câmbio): buy/sell derivation, mid-market sanity band, 30s cache. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getRates, _resetRatesCache, type RateQuoteFn } from "../src/modules/money/rates.service.js";

beforeEach(_resetRatesCache);

// quote returns the pair's bare BRL-per-unit basePrice. BRL/USD via USDT, BRL/EUR via EURC.
const quote: RateQuoteFn = async ({ inputCurrency, outputCurrency }) => {
  if (inputCurrency === "BRLA" && outputCurrency === "USDT") return { price: 5.43 }; // buy USD
  if (inputCurrency === "USDT" && outputCurrency === "BRLA") return { price: 5.38 }; // sell USD
  if (inputCurrency === "BRLA" && outputCurrency === "EURC") return { price: 5.92 }; // EUR one way
  return null;
};
const mid = async () => ({ brlPerUsd: 5.4, brlPerEur: 5.9 });

test("derives BRL-per-unit buy/sell + one-way EUR from raw amounts, within the sane band", async () => {
  const r = await getRates("sub-1", quote, mid, () => 1000);
  assert.ok(Math.abs(r.brlUsd.buy! - 5.43) < 0.01);
  assert.ok(Math.abs(r.brlUsd.sell! - 5.38) < 0.01);
  assert.equal(r.brlUsd.mid, 5.4);
  assert.ok(Math.abs(r.brlEur.buy! - 5.92) < 0.01);
  assert.equal(r.brlEur.mid, 5.9);
});

test("an Avenia rate far from mid-market is dropped (suspect), mid still shown", async () => {
  _resetRatesCache();
  const brokenQuote: RateQuoteFn = async ({ inputCurrency, outputCurrency }) =>
    inputCurrency === "BRLA" && outputCurrency === "USDT" ? { price: 2.0 } : null; // way off 5.4
  const r = await getRates("s", brokenQuote, mid, () => 2000);
  assert.equal(r.brlUsd.buy, null); // dropped, not displayed as real
  assert.equal(r.brlUsd.mid, 5.4); // reference still there
});

test("degrades to nulls when Avenia + mid-market both unavailable; never throws", async () => {
  _resetRatesCache();
  const r = await getRates("s", async () => null, async () => ({ brlPerUsd: null, brlPerEur: null }), () => 3000);
  assert.deepEqual(r.brlUsd, { buy: null, sell: null, mid: null });
  assert.deepEqual(r.brlEur, { buy: null, mid: null });
});

test("a degraded (no-subaccount / Avenia-down) result is NOT cached, so it can't poison other orgs", async () => {
  _resetRatesCache();
  // First caller has no working quote (e.g. onboarding org, no subaccount) but mid is reachable.
  const r1 = await getRates("no-sub", async () => null, mid, () => 6000);
  assert.equal(r1.brlUsd.buy, null); // mid-only, degraded
  assert.equal(r1.brlUsd.mid, 5.4);
  // A provisioned org calling 1s later must NOT be served the poisoned mid-only entry.
  const r2 = await getRates("sub-1", quote, mid, () => 7000);
  assert.ok(Math.abs(r2.brlUsd.buy! - 5.43) < 0.01); // real rate, not the cached null
});

test("caches within 30s (a second call does not re-quote)", async () => {
  _resetRatesCache();
  let calls = 0;
  const counting: RateQuoteFn = async (i) => {
    calls++;
    return quote(i);
  };
  await getRates("s", counting, mid, () => 5000);
  const firstCalls = calls;
  await getRates("s", counting, mid, () => 5000 + 10_000); // +10s < 30s
  assert.equal(calls, firstCalls); // served from cache
  await getRates("s", counting, mid, () => 5000 + 40_000); // +40s > 30s
  assert.ok(calls > firstCalls); // re-quoted
});
