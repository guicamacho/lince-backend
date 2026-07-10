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
import { getAuth, clerkClient } from "@clerk/express";

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
 * Always require an ENROLLED second factor, independent of the global (optional) MFA policy.
 * Used on the payee/money-out surface: adding a beneficiary requires 2FA — the first payee is
 * the enrollment trigger (PRD-02 F4). Enrollment persists, so later payees pass without
 * friction; this is not a step-up re-challenge (requireStepUp handles fresh re-verification).
 *
 * Reads `twoFactorEnabled` from the Clerk Backend API — authoritative and current (a disabled
 * factor is reflected immediately, unlike the TTL-bounded session claim). Fails CLOSED: any
 * lookup error blocks the money-out action rather than letting it through.
 */
type EnrollmentClient = { users: { getUser: (id: string) => Promise<{ twoFactorEnabled: boolean }> } };

/** true iff the Clerk user has an enrolled second factor (authoritative, current). */
const enrolledVia = (client: EnrollmentClient) => async (id: string): Promise<boolean> =>
  (await client.users.getUser(id)).twoFactorEnabled === true;

async function applyGate(res: Response, next: NextFunction, result: GateResult): Promise<void> {
  if (result === "ok") next();
  else res.status(result.status).json(result.body);
}

export function requireMfaEnrolled(client: EnrollmentClient = clerkClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await applyGate(res, next, await mfaEnrolledGate(getAuth(req).userId, enrolledVia(client)));
  };
}

/**
 * Global MFA policy middleware (optional by default = pass-through). When "mandatory", reads
 * enrollment authoritatively — same source as the payee gate. Wave 2 passes env.mfa.policy.
 */
export function requireMfa(
  policy: MfaPolicy = process.env.MFA_POLICY === "mandatory" ? "mandatory" : "optional",
  client: EnrollmentClient = clerkClient,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (policy === "optional") {
      next();
      return;
    }
    await applyGate(res, next, await mfaEnrolledGate(getAuth(req).userId, enrolledVia(client)));
  };
}
