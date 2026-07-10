import { test } from "node:test";
import assert from "node:assert/strict";
import { toMinor, fromMinor, decimalsFor, vendorMinor, parseCustomerAmount } from "../src/money/money.js";

// vendorMinor: lenient, non-throwing, rounds to dp (for Avenia-supplied amounts/fees).
test("vendorMinor rounds extra decimals half-up, never throws", () => {
  assert.equal(vendorMinor("99.808", "BRLA"), 9981n); // 99.81
  assert.equal(vendorMinor("0.015", "BRL"), 2n); // 0.02
  assert.equal(vendorMinor("0.2", "BRL"), 20n);
  assert.equal(vendorMinor("100", "BRL"), 10000n);
  assert.equal(vendorMinor("", "BRL"), 0n); // malformed -> 0, not a throw
  assert.equal(vendorMinor("not-a-number", "BRL"), 0n);
  assert.equal(vendorMinor("1e9", "BRL"), 0n); // scientific notation is not a plain decimal
});

// parseCustomerAmount: strict; returns null on anything a customer shouldn't be able to submit.
test("parseCustomerAmount accepts clean decimals, rejects the rest", () => {
  assert.equal(parseCustomerAmount("100", "BRL"), 10000n);
  assert.equal(parseCustomerAmount("100.50", "BRL"), 10050n);
  assert.equal(parseCustomerAmount("0", "BRL"), null); // must be > 0
  assert.equal(parseCustomerAmount("1e9", "BRL"), null);
  assert.equal(parseCustomerAmount("0x10", "BRL"), null);
  assert.equal(parseCustomerAmount("1,00", "BRL"), null);
  assert.equal(parseCustomerAmount("100.123", "BRL"), null); // > 2 dp
  assert.equal(parseCustomerAmount("  ", "BRL"), null);
  assert.equal(parseCustomerAmount("99999999999999999999", "BRL"), null); // over the cap
  assert.equal(parseCustomerAmount("-5", "BRL"), null);
});


test("BRL round-trips at 2 decimals", () => {
  assert.equal(toMinor("12.34", "BRL"), 1234n);
  assert.equal(fromMinor(1234n, "BRL"), "12.34");
});

test("USDC round-trips at 6 decimals", () => {
  assert.equal(toMinor("1.000001", "USDC"), 1_000_001n);
  assert.equal(fromMinor(1_000_001n, "USDC"), "1.000001");
});

test("negatives round-trip", () => {
  assert.equal(toMinor("-5.00", "USD"), -500n);
  assert.equal(fromMinor(-500n, "USD"), "-5.00");
});

test("over-precision throws", () => {
  assert.throws(() => toMinor("1.234", "BRL"));
});

test("decimalsFor per currency", () => {
  assert.equal(decimalsFor("BRL"), 2);
  assert.equal(decimalsFor("USDT"), 6);
});
