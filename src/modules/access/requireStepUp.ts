/**
 * Step-up (re-authentication) gate for sensitive mutations.
 *
 * Two pieces: a PURE decision (unit-testable, no Clerk/Express) and a thin Express
 * middleware factory that reads the caller's Clerk auth (userId + strict
 * reverification freshness) and applies it.
 *
 * Flag STEP_UP_ENFORCED gates the whole thing (default OFF): when off this is a
 * pass-through — the surrounding /app active-org gate already handles auth. When on,
 * a sensitive route additionally requires a FRESH strict reverification.
 *
 * Mount + env wiring land in Wave 2; the factory takes `enforced` so that wiring is
 * one line (`requireStepUp(env.stepUp.enforced)`) — same seam as adminAuth reads env.
 */
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export type StepUpDecision = "ok" | "unauthenticated" | "step_up_required";

/** Pure gate. enforced off => always ok (auth is handled by the outer /app gate). */
export function stepUpDecision(
  enforced: boolean,
  userId: string | null | undefined,
  isFresh: boolean,
): StepUpDecision {
  if (!enforced) return "ok";
  if (!userId) return "unauthenticated";
  if (!isFresh) return "step_up_required";
  return "ok";
}

/**
 * Express middleware. `enforced` defaults to the STEP_UP_ENFORCED env flag (off unless
 * exactly "true"); Wave 2 passes env.stepUp.enforced explicitly — one line, same seam.
 */
export function requireStepUp(enforced = process.env.STEP_UP_ENFORCED === "true") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { userId, has } = getAuth(req);
    const isFresh = has?.({ reverification: "strict" }) === true;
    switch (stepUpDecision(enforced, userId, isFresh)) {
      case "unauthenticated":
        res.status(401).json({ error: "unauthenticated" });
        return;
      case "step_up_required":
        res.status(403).json({ error: "step_up_required" });
        return;
      default:
        next();
    }
  };
}
