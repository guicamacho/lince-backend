/**
 * Dev-only mock KYB provider — stands in for Didit's hosted capture so the v1
 * skeleton flow runs without the real (vendor-gated) integration. No KYC PII; it
 * just returns a fake session. The real Didit client gets written when the
 * vendor confirmations land (BUILD_BRIEF §6).
 */
import type { KybProvider } from "../provider.types.js";

export class MockKybProvider implements KybProvider {
  async launchVerification(input: { orgId: string }): Promise<{ diditSessionId: string; hostedUrl: string }> {
    return { diditSessionId: `mock_${input.orgId}`, hostedUrl: `mock://didit/${input.orgId}` };
  }
}
