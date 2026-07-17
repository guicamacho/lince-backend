/**
 * Money is ALWAYS signed bigint minor units. Never floats, never Number for amounts.
 * Per-currency decimal places. (BRLA is held; "R$" is presentation-only — same 2 dp as BRL.)
 */
export type Currency = "BRL" | "BRLA" | "USD" | "EUR" | "USDC" | "USDT" | "EURC";

const DECIMALS: Record<Currency, number> = {
  BRL: 2,
  BRLA: 2, // Avenia's BRL stablecoin — displayed as R$, same 2 dp
  USD: 2,
  EUR: 2,
  USDC: 6,
  USDT: 6,
  EURC: 6, // Circle's euro coin — displayed as €, 6 dp like USDC
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

/**
 * Vendor-supplied (Avenia) decimal amount -> minor units. LENIENT and NON-THROWING: rounds
 * extra fractional digits to the currency's dp (half-up), returns 0n on a non-numeric string.
 * Vendor amounts must NEVER crash a read or the settle path (a stray >dp fee once 500'd the
 * whole transactions list). ponytail: rounds to our dp; if Avenia ever credits sub-centavo
 * BRLA the remainder is lost — widen DECIMALS.BRLA when that becomes real.
 */
export function vendorMinor(amount: string, currency: Currency): bigint {
  // The currency is ALSO vendor-supplied (fee rows arrive as free strings cast to Currency):
  // an unmapped label must degrade like a bad amount does, never throw. 2 dp = the map's mode.
  // hasOwn, not ??: a prototype-key label ("toString") makes the bare lookup return a function.
  const dp = Object.hasOwn(DECIMALS, currency) ? DECIMALS[currency] : 2;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount ?? "").trim());
  if (!m) return 0n;
  const sign = m[1];
  const whole = m[2]!;
  const frac = m[3] ?? "";
  const base = 10n ** BigInt(dp);
  let minor = BigInt(whole) * base + BigInt((frac + "0".repeat(dp)).slice(0, dp) || "0");
  if (frac.length > dp && Number(frac[dp]) >= 5) minor += 1n; // round half-up
  return sign === "-" ? -minor : minor;
}

/**
 * Strict validation for CUSTOMER-entered money: a non-negative decimal with at most the
 * currency's dp places, greater than zero and within a sane cap (well under int8). Returns the
 * minor-unit bigint, or null if invalid (callers return 422). Never throws.
 */
const MAX_MINOR = 10n ** 13n; // ~100 billion units — far above any real deposit, far below int8 max
export function parseCustomerAmount(amount: string, currency: Currency): bigint | null {
  const dp = DECIMALS[currency];
  const s = String(amount ?? "").trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${dp}})?$`).test(s)) return null;
  const v = toMinor(s, currency);
  return v > 0n && v <= MAX_MINOR ? v : null;
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
