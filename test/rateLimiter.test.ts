/** PostgresRateLimiter against lince_test — fixed-window increment + reset. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { PostgresRateLimiter } from "../src/modules/ratelimit/port.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// Fixed `now` per test so the window can't straddle a real-clock boundary.
const T = 1_700_000_000_000;

test("N calls allowed, N+1 blocked with retryAfter > 0", async () => {
  const rl = new PostgresRateLimiter();
  const key = `user:${Math.random()}`;
  for (let i = 0; i < 5; i++) {
    const d = await rl.check(key, "cnpj_lookup", 5, 60, T);
    assert.equal(d.allowed, true, `call ${i + 1} should be allowed`);
    assert.equal(d.retryAfter, 0);
  }
  const over = await rl.check(key, "cnpj_lookup", 5, 60, T);
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfter > 0, "blocked call reports seconds to window end");
});

test("a fresh window resets the count", async () => {
  const rl = new PostgresRateLimiter();
  const key = `user:${Math.random()}`;
  const next = T + 60_000; // the following 60s window
  for (let i = 0; i < 5; i++) await rl.check(key, "c", 5, 60, T);
  assert.equal((await rl.check(key, "c", 5, 60, T)).allowed, false); // 6th in window 1 blocked
  assert.equal((await rl.check(key, "c", 5, 60, next)).allowed, true); // window 2 starts fresh
});

test("distinct keys and classes count independently", async () => {
  const rl = new PostgresRateLimiter();
  const a = `user:${Math.random()}`;
  const b = `org:${Math.random()}`;
  assert.equal((await rl.check(a, "reads", 1, 60, T)).allowed, true);
  assert.equal((await rl.check(a, "reads", 1, 60, T)).allowed, false); // same key+class trips
  assert.equal((await rl.check(b, "reads", 1, 60, T)).allowed, true); // different key: own budget
  assert.equal((await rl.check(a, "quote", 1, 60, T)).allowed, true); // same key, other class: own budget
});
