/**
 * MFA gates for sensitive mutations. Two distinct questions, two signals — do not conflate:
 *
 *   - ENROLLMENT ("does this user have 2FA set up?") — authoritative via the Clerk Backend
 *     API (`user.twoFactorEnabled`). This is what the payee/money-out gate needs, and it is
 *     the SAME signal the customer UI gates on (currentUser().twoFactorEnabled), so the two
 *     agree — no "form shown then hard-403'd" lockout.
 *   - VERIFICATION FRESHNESS ("was the 2nd factor verified recently in THIS session?") — the
 *     `fva` session claim, used by requireStepUp for re-challenge. NOT an enrollment flag.
 *
 * An earlier version gated payees on `fva` (verification age). That was wrong: it fails open
 * on non-numeric claim shapes, fails open for ~1 token TTL after 2FA is disabled, and blocks
 * enrolled users whose session predates enrollment. Adversarial review (2026-07-10) confirmed
 * all three. The payee gate now reads enrollment authoritatively and fails CLOSED on any error.
 *
 * Ruling (PRD-07 v5): global MFA policy is OPTIONAL by default; SMS disabled; 24h post-recovery
 * money-out hold lives in recoveryHold.ts.
 */
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export type MfaPolicy = "optional" | "mandatory";
export type MfaDecision = "ok" | "unauthenticated" | "mfa_required";

/** Pure gate for the global policy. policy "optional" => always ok (the ratified default). */
export function mfaDecision(
  policy: MfaPolicy,
  userId: string | null | undefined,
  secondFactorEnrolled: boolean,
): MfaDecision {
  if (policy === "optional") return "ok";
  if (!userId) return "unauthenticated";
  if (!secondFactorEnrolled) return "mfa_required";
  return "ok";
}

export type GateResult = "ok" | { status: number; body: Record<string, unknown> };

/**
 * Pure enrollment gate (the whole security decision, no Clerk/Express). Fails CLOSED:
 * no user => 401; lookup throws => 503 (never allow the action we can't verify); not
 * enrolled => 403; enrolled => ok. Unit-tested; the middleware below is thin glue.
 */
export async function mfaEnrolledGate(
  userId: string | null | undefined,
  isEnrolled: (id: string) => Promise<boolean>,
): Promise<GateResult> {
  if (!userId) return { status: 401, body: { error: "unauthenticated" } };
  let enrolled: boolean;
  try {
    enrolled = await isEnrolled(userId);
  } catch {
    return { status: 503, body: { error: "mfa_check_unavailable" } };
  }
  return enrolled ? "ok" : { status: 403, body: { error: "mfa_required", action: "enrol" } };
}

/**
 * MFA is satisfied by EITHER a second factor (TOTP) OR a passkey — product ruling 2026-07-10
 * ("you only need one, Authenticator or Passkey"). NOTE: Clerk's `two_factor_enabled` does NOT
 * count passkeys (they're a first-factor strategy), and the @clerk SDK's user object silently
 * drops the `passkeys` field — so we read the RAW Clerk API, which returns both.
 */
export function computeHasMfa(u: { two_factor_enabled?: boolean; passkeys?: unknown[] }): boolean {
  return u.two_factor_enabled === true || (Array.isArray(u.passkeys) && u.passkeys.length > 0);
}

/** Raw Clerk API user fetch (the SDK drops `passkeys`). Throws on non-2xx => gate fails closed. */
async function clerkUserHasMfa(userId: string): Promise<boolean> {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY ?? ""}` },
  });
  if (!res.ok) throw new Error(`clerk users.get ${res.status}`);
  return computeHasMfa((await res.json()) as { two_factor_enabled?: boolean; passkeys?: unknown[] });
}

/**
 * Always require MFA (TOTP or passkey), independent of the global (optional) MFA policy. Used on
 * the payee/money-out surface: adding a beneficiary requires MFA — the first payee is the
 * enrollment trigger (PRD-02 F4). Authoritative + current (a removed factor reflects immediately);
 * fails CLOSED — any lookup error blocks the money-out action rather than letting it through.
 * `isEnrolled` is injectable for tests.
 */
async function applyGate(res: Response, next: NextFunction, result: GateResult): Promise<void> {
  if (result === "ok") next();
  else res.status(result.status).json(result.body);
}

export function requireMfaEnrolled(isEnrolled: (id: string) => Promise<boolean> = clerkUserHasMfa) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await applyGate(res, next, await mfaEnrolledGate(getAuth(req).userId, isEnrolled));
  };
}

/**
 * Global MFA policy middleware (optional by default = pass-through). When "mandatory", uses the
 * same "TOTP or passkey" check as the payee gate. Wave 2 passes env.mfa.policy.
 */
export function requireMfa(
  policy: MfaPolicy = process.env.MFA_POLICY === "mandatory" ? "mandatory" : "optional",
  isEnrolled: (id: string) => Promise<boolean> = clerkUserHasMfa,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (policy === "optional") {
      next();
      return;
    }
    await applyGate(res, next, await mfaEnrolledGate(getAuth(req).userId, isEnrolled));
  };
}
