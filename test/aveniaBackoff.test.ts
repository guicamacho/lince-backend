/** withUpstreamBackoff — 429 re-quotes then retries; other errors/paths untouched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withUpstreamBackoff } from "../src/modules/providers/avenia/backoff.js";

const is429 = (e: unknown): boolean => (e as { status?: number } | null)?.status === 429;

test("429 on the first attempt => re-quote, retry with the fresh token", async () => {
  let reQuotes = 0;
  let calls = 0;
  const result = await withUpstreamBackoff<string, string>(
    async (token) => {
      calls++;
      if (calls === 1) {
        assert.equal(token, "q1");
        throw { status: 429 };
      }
      assert.equal(token, "q2", "retry uses the re-quoted token, not the stale one");
      return "ticket-ok";
    },
    "q1",
    { isRateLimited: is429, reQuote: async () => { reQuotes++; return "q2"; } },
  );
  assert.equal(result, "ticket-ok");
  assert.equal(reQuotes, 1);
  assert.equal(calls, 2);
});

test("success on the first attempt => no re-quote (pass-through)", async () => {
  let reQuotes = 0;
  const r = await withUpstreamBackoff<string, string>(
    async () => "ok",
    "q1",
    { isRateLimited: is429, reQuote: async () => { reQuotes++; return "q2"; } },
  );
  assert.equal(r, "ok");
  assert.equal(reQuotes, 0);
});

test("a non-429 error is rethrown without re-quoting", async () => {
  let reQuotes = 0;
  await assert.rejects(
    withUpstreamBackoff<string, string>(
      async () => { throw new Error("boom"); },
      "q1",
      { isRateLimited: is429, reQuote: async () => { reQuotes++; return "q2"; } },
    ),
    /boom/,
  );
  assert.equal(reQuotes, 0);
});

test("exhausted attempts rethrow the last 429", async () => {
  let reQuotes = 0;
  await assert.rejects(
    withUpstreamBackoff<string, string>(
      async () => { throw { status: 429 }; },
      "q1",
      { isRateLimited: is429, reQuote: async () => { reQuotes++; return "q2"; }, maxAttempts: 2 },
    ),
    (e: unknown) => is429(e),
  );
  assert.equal(reQuotes, 1); // one re-quote between the two attempts
});
