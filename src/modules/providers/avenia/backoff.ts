/**
 * Upstream-429 backoff for Avenia money calls (WP-B13 / PRD-07 §1, Avenia #10).
 *
 * A 429'd createTicket must NOT be blindly retried: the fixed-rate quote lives ~15s, so
 * the old quoteToken may already be stale. On a rate-limit error we RE-QUOTE and retry
 * with the fresh token; any other error propagates untouched.
 *
 * DORMANT this session — the Avenia client throws before any HTTP call (BUILD_BRIEF §6);
 * built + tested against a fake now, live the day the client lands.
 */

export interface UpstreamBackoffOptions<Q> {
  /** True if the thrown error is an upstream rate-limit (e.g. HTTP 429). */
  isRateLimited: (err: unknown) => boolean;
  /** Fetch a fresh quote/token to retry with after a 429. */
  reQuote: () => Promise<Q>;
  /** Total attempts including the first (default 2 = one re-quote retry). */
  maxAttempts?: number;
}

/**
 * Run `attempt(quote)`; on a rate-limit error re-quote and retry with the new quote,
 * up to `maxAttempts`. Returns the first success; rethrows the last error otherwise.
 */
export async function withUpstreamBackoff<Q, R>(
  attempt: (quote: Q) => Promise<R>,
  initialQuote: Q,
  opts: UpstreamBackoffOptions<Q>,
): Promise<R> {
  const max = opts.maxAttempts ?? 2;
  let quote = initialQuote;
  for (let i = 1; ; i++) {
    try {
      return await attempt(quote);
    } catch (err) {
      if (i >= max || !opts.isRateLimited(err)) throw err;
      quote = await opts.reQuote(); // stale-token-safe: retry with a fresh quote, not the old one
    }
  }
}
