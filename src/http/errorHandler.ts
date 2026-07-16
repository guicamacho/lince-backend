/**
 * Error handler — Express 5 forwards rejected async handlers here.
 * Contention timeouts (PRD-07 §7 "fail fast, RETRY SAFE"): pg 55P03 (lock_timeout) and
 * 57014 (statement_timeout/cancel) become a retryable 503 with a neutral body — never a
 * raw-message 500 a client would treat as fatal (verification-sweep finding, 2026-07-06).
 */
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "./error.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const pgCode = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : null;
  if (pgCode === "55P03" || pgCode === "57014") {
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "temporarily_unavailable" });
    return;
  }
  // HttpError carries a curated, safe message (our own codes). ANY other error (pg, thrown
  // Error, syntax) is logged server-side and returned as a NEUTRAL body — never echo raw
  // messages (constraint/column names, "cannot convert to BigInt") to the client.
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  // Framework 4xx (body-parser's malformed-JSON 400 / oversized 413 are http-errors that also
  // carry statusCode): keep the status, neutralize the message — parser internals stay server-side.
  const fwStatus = err instanceof Error && "statusCode" in err ? Number((err as { statusCode: unknown }).statusCode) : NaN;
  if (fwStatus >= 400 && fwStatus < 500) {
    res.status(fwStatus).json({ error: "bad_request" });
    return;
  }
  console.warn("unhandled_error", JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  res.status(500).json({ error: "internal_error" });
}
