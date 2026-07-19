/** Avenia's webhook-signing public key (GET /v2/public-key, unauthenticated).
 *  Review 2026-07-20: fetch is bounded (4s) so a hung vendor endpoint can't stall webhook
 *  intake, and the cache has a TTL so key rotation no longer requires a restart. On a
 *  failed refresh the stale key is kept — verification degrades gracefully instead of
 *  failing closed on a vendor blip. */
import { env } from "../../config/env.js";

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — rotation lag bounded to one TTL
let cached: { key: string; at: number } | null = null;

export async function aveniaWebhookPublicKey(): Promise<string | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.key;
  try {
    const res = await fetch(`${env.avenia.baseUrl}/v2/public-key`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return cached?.key ?? null;
    const key = ((await res.json()) as { publicKey?: string }).publicKey ?? null;
    if (key) cached = { key, at: Date.now() };
    return key ?? cached?.key ?? null;
  } catch {
    return cached?.key ?? null; // stale-on-error beats no-verification
  }
}
