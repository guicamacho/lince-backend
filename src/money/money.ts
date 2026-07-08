/**
 * Money is ALWAYS signed bigint minor units. Never floats, never Number for amounts.
 * Per-currency decimal places. (BRLA is held; "R$" is presentation-only — same 2 dp as BRL.)
 */
export type Currency = "BRL" | "BRLA" | "USD" | "EUR" | "USDC" | "USDT";

const DECIMALS: Record<Currency, number> = {
  BRL: 2,
  BRLA: 2, // Avenia's BRL stablecoin — displayed as R$, same 2 dp
  USD: 2,
  EUR: 2,
  USDC: 6,
  USDT: 6,
};

export function decimalsFor(currency: Currency): number {
  return DECIMALS[currency];
}

/** "12.34" -> 1234n (for BRL). Throws on more fractional digits than the currency allows. */
export function toMinor(amount: string, currency: Currency): bigint {
  const dp = DECIMALS[currency];
  const neg = amount.trim().startsWith("-");
  const [whole, frac = ""] = amount.trim().replace(/^[-+]/, "").split(".");
  if (frac.length > dp) throw new Error(`${amount} has more than ${dp} fractional digits for ${currency}`);
  const padded = (frac + "0".repeat(dp)).slice(0, dp);
  const value = BigInt(whole || "0") * 10n ** BigInt(dp) + BigInt(padded || "0");
  return neg ? -value : value;
}

/** 1234n -> "12.34" (for BRL). Presentation only. */
export function fromMinor(minor: bigint, currency: Currency): string {
  const dp = DECIMALS[currency];
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const base = 10n ** BigInt(dp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(dp, "0");
  return `${neg ? "-" : ""}${whole}${dp ? "." + frac : ""}`;
}
