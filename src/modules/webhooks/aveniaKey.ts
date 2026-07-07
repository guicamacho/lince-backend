/** Avenia's webhook-signing public key (GET /v2/public-key, unauthenticated).
 *  ponytail: cached for the process lifetime — key rotation = restart; add TTL/refetch-on-
 *  verify-failure if Avenia ever rotates keys in practice. */
import { env } from "../../config/env.js";

let cached: string | null = null;

export async function aveniaWebhookPublicKey(): Promise<string | null> {
  if (cached) return cached;
  try {
    const res = await fetch(`${env.avenia.baseUrl}/v2/public-key`);
    if (!res.ok) return null;
    cached = ((await res.json()) as { publicKey?: string }).publicKey ?? null;
  } catch {
    return null;
  }
  return cached;
}
