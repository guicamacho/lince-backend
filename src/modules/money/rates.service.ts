/**
 * Display FX rates for the Início Câmbio board. Decision 2026-07-12: use the Avenia stablecoin
 * quote (BRLA<>USDT both ways for BRL-USD; BRLA>EUR one way) — a display-only GET quote, NOT the
 * gated ticket path — and CHECK each against a public mid-market rate. Rates are BARE (no Lince
 * markup; Modelo A has no spread). Cached ~30s (rates are market-wide, not per-org).
 *
 * Honesty rules: the mid-market reference always shows if reachable; the Avenia-derived rate shows
 * only when it's within a sane band of mid-market (a broken/miscalibrated quote is dropped, never
 * displayed as a real rate). Everything degrades to null — a dashboard read never throws.
 */
export interface PairRate {
  /** BRL per 1 unit of the quote currency (USD/EUR). null when unavailable/suspect. */
  buy: number | null; // customer buys USD/EUR (BRL out): BRLA -> stablecoin
  sell: number | null; // customer sells USD/EUR (BRL in): stablecoin -> BRLA
  mid: number | null; // public mid-market reference
}
export interface Rates {
  brlUsd: PairRate;
  brlEur: Pick<PairRate, "buy" | "mid">; // one-way per the product decision
  updatedAt: string;
}

/** A quote fn (injected; the AveniaClient.quoteRate in prod) returning the pair's bare BRL-per-unit
 *  price (Avenia basePrice) or null. */
export type RateQuoteFn = (input: {
  subAccountId: string;
  inputCurrency: string;
  outputCurrency: string;
}) => Promise<{ price: number } | null>;

/** Mid-market fetch (injected): BRL per USD and BRL per EUR, or nulls. */
export type MidMarketFn = () => Promise<{ brlPerUsd: number | null; brlPerEur: number | null }>;

const CACHE_MS = 30_000;
const SANE_BAND = 0.08; // Avenia rate must be within 8% of mid-market, else it's dropped as suspect
let cache: { rates: Rates; at: number } | null = null;

/** Default mid-market source: open.er-api.com (free, no key). USD-based; derive BRL/EUR. */
export const fetchMidMarket: MidMarketFn = async () => {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { brlPerUsd: null, brlPerEur: null };
    const j = (await res.json()) as { rates?: { BRL?: number; EUR?: number } };
    const brl = Number(j.rates?.BRL);
    const eur = Number(j.rates?.EUR);
    return {
      brlPerUsd: Number.isFinite(brl) && brl > 0 ? brl : null,
      brlPerEur: Number.isFinite(brl) && brl > 0 && Number.isFinite(eur) && eur > 0 ? brl / eur : null,
    };
  } catch {
    return { brlPerUsd: null, brlPerEur: null };
  }
};

/** Keep an Avenia-derived rate only if it's within SANE_BAND of the mid-market reference. */
function checked(rate: number | null, mid: number | null): number | null {
  if (rate === null) return null;
  if (mid === null) return rate; // no reference to check against — surface it as-is
  return Math.abs(rate - mid) / mid <= SANE_BAND ? rate : null;
}

/** now() injectable so the cache TTL is testable without the wall clock. */
export async function getRates(
  subAccountId: string,
  quote: RateQuoteFn,
  midMarket: MidMarketFn = fetchMidMarket,
  now: () => number = Date.now,
): Promise<Rates> {
  if (cache && now() - cache.at < CACHE_MS) return cache.rates;

  const [usdBuy, usdSell, eurBuy, mid] = await Promise.all([
    quote({ subAccountId, inputCurrency: "BRLA", outputCurrency: "USDT" }), // BRL -> USD (buy USD)
    quote({ subAccountId, inputCurrency: "USDT", outputCurrency: "BRLA" }), // USD -> BRL (sell USD)
    quote({ subAccountId, inputCurrency: "BRLA", outputCurrency: "EURC" }), // BRL -> EUR one way (EURC proxy)
    midMarket(),
  ]);

  // basePrice is already BRL per foreign unit (pair is quoted FOREIGN/BRLA both ways), so it maps
  // straight through — no division, no direction juggling. The sane-band check vs mid catches any
  // future inversion.
  const usdBuyRate = usdBuy ? usdBuy.price : null;
  const usdSellRate = usdSell ? usdSell.price : null;
  const eurBuyRate = eurBuy ? eurBuy.price : null;

  const rates: Rates = {
    brlUsd: {
      buy: checked(usdBuyRate, mid.brlPerUsd),
      sell: checked(usdSellRate, mid.brlPerUsd),
      mid: mid.brlPerUsd,
    },
    brlEur: { buy: checked(eurBuyRate, mid.brlPerEur), mid: mid.brlPerEur },
    updatedAt: new Date(now()).toISOString(),
  };
  // Only cache a result that actually carries an Avenia-derived rate. The cache is shared across
  // orgs (rates are market-wide), so a caller with no subaccount — or a transient Avenia failure —
  // must NOT poison the shared entry with a mid-only (buy/sell null) result for the next 30s.
  if (rates.brlUsd.buy !== null || rates.brlUsd.sell !== null || rates.brlEur.buy !== null) {
    cache = { rates, at: now() };
  }
  return rates;
}

/** test seam: drop the module cache. */
export function _resetRatesCache() {
  cache = null;
}
