/**
 * Didit client — STUBBED. Hosted capture + identity/company verification; results
 * forwarded to Avenia (pass-through, NO PII retained by Lince).
 *
 * Gated on vendor confirmations (BUILD_BRIEF §6): BR-CNPJ / MX / CO registry coverage
 * (every example seen was UK), webhook payloads, the Didit->Avenia transfer mechanism,
 * AML scope. Leave this interface in place; fill the implementation once confirmed.
 */
import type { KybProvider } from "../provider.types.js";

export class DiditClient implements KybProvider {
  async launchVerification(_input: { orgId: string }): Promise<{ diditSessionId: string; hostedUrl: string }> {
    throw new Error("STUB: Didit capture gated on vendor confirmation (BUILD_BRIEF §6)");
  }
}
