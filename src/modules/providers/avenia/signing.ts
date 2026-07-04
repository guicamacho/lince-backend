/**
 * Avenia request signing (PKCS#1 v1.5, RSA-SHA256, base64).
 *
 * string_to_sign = timestamp + METHOD + requestUri + (body ?? "")
 *   - timestamp  : ms-since-epoch as a string (echoed back so the caller sends the same value it signed)
 *   - METHOD     : upper-cased HTTP verb
 *   - requestUri : path INCLUDING the full query string (e.g. "/v2/...?subAccountId=abc")
 *   - body       : the exact serialized request body, or "" for bodyless requests
 */
import { createSign } from "node:crypto";

export interface AveniaSignInput {
  method: string;
  requestUri: string;
  body?: string;
  privateKeyPem: string;
  /** ms-since-epoch string; defaults to Date.now() so signature and header stay in lockstep. */
  timestamp?: string;
}

export interface AveniaSignature {
  timestamp: string;
  signature: string;
}

export function signAveniaRequest(input: AveniaSignInput): AveniaSignature {
  const timestamp = input.timestamp ?? String(Date.now());
  const stringToSign = timestamp + input.method.toUpperCase() + input.requestUri + (input.body ?? "");
  const signer = createSign("RSA-SHA256");
  signer.update(stringToSign);
  signer.end();
  return { timestamp, signature: signer.sign(input.privateKeyPem, "base64") };
}

/** The four headers a signed Avenia request carries. */
export function aveniaSignedHeaders(apiKey: string, input: AveniaSignInput): Record<string, string> {
  const { timestamp, signature } = signAveniaRequest(input);
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-API-Timestamp": timestamp,
    "X-API-Signature": signature,
  };
}
