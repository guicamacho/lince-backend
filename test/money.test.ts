import { test } from "node:test";
import assert from "node:assert/strict";
import { toMinor, fromMinor, decimalsFor } from "../src/money/money.js";

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
