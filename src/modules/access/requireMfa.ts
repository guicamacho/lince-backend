/**
 * MFA policy gate for sensitive mutations.
 *
 * Mirror of requireStepUp.ts: a PURE decision (unit-testable, no Clerk/Express) plus a
 * thin Express middleware that reads the caller's Clerk auth and applies it.
 *
 * Ruling (PRD-07 v5, 2026-07-04): policy is OPTIONAL by default (config-only flip to
 * mandatory); SMS is disabled (a Clerk-dashboard setting mirrored as the documented
 * MFA_SMS_ENABLED flag — no factor-selection code lives here); the 24h post-recovery
 * money-out hold lives in recoveryHold.ts. When policy is "optional" this is a
 * pass-through — auth is already handled by the outer /app active-org gate.
 *
 * Second-factor signal = the free Clerk session claim `fva` (factor-verification age):
 * fva[1] is the age of the SECOND factor; -1 means "never verified / not enrolled". This
 * is synchronous (no Backend API round-trip). `fva` is @experimental — flagged.
 *
 * Mount + env wiring land in Wave 2; the factory takes `policy` so wiring is one line
 * (`requireMfa(env.mfa.policy)`) — same seam as requireStepUp(env.stepUp.enforced).
 */
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export type MfaPolicy = "optional" | "mandatory";
export type MfaDecision = "ok" | "unauthenticated" | "mfa_required";

/** Pure gate. policy "optional" => always ok (the ratified default). */
export function mfaDecision(
  policy: MfaPolicy,
  userId: string | null | undefined,
  secondFactorPresent: boolean,
): MfaDecision {
  if (policy === "optional") return "ok";
  if (!userId) return "unauthenticated";
  if (!secondFactorPresent) return "mfa_required";
  return "ok";
}

/**
 * Express middleware. `policy` defaults to the MFA_POLICY env flag (only exactly
 * "mandatory" flips it — the ruling default is optional); Wave 2 passes env.mfa.policy
 * explicitly — one line, same seam as requireStepUp.
 */
export function requireMfa(
  policy: MfaPolicy = process.env.MFA_POLICY === "mandatory" ? "mandatory" : "optional",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { userId, sessionClaims } = getAuth(req);
    // fva = [firstFactorAge, secondFactorAge]; secondFactorAge === -1 => no 2FA verified.
    const fva = sessionClaims?.fva;
    const secondFactorPresent = fva !== undefined && fva[1] !== -1;
    switch (mfaDecision(policy, userId, secondFactorPresent)) {
      case "unauthenticated":
        res.status(401).json({ error: "unauthenticated" });
        return;
      case "mfa_required":
        res.status(403).json({ error: "mfa_required", action: "enrol" });
        return;
      default:
        next();
    }
  };
}
