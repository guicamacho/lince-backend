/**
 * Dev-only mock KYB provider — stands in for Didit's hosted capture so the v1
 * skeleton flow runs without the real (vendor-gated) integration. No KYC PII.
 *
 * PRD-01 §9: launching now persists the session reference in didit_verifications
 * (idempotent per org — the RFI re-launch path re-enters here, and 0001 has no
 * unique index on org_id, so update-else-insert keeps one row per org). The real
 * Didit client will follow the same shape.
 */
import { pool } from "../../../db/pool.js";
import type { KybProvider } from "../provider.types.js";

export class MockKybProvider implements KybProvider {
  async launchVerification(input: { orgId: string }): Promise<{ diditSessionId: string; hostedUrl: string }> {
    const diditSessionId = `mock_${input.orgId}`;
    const upd = await pool.query(
      `update didit_verifications set didit_session_id = $2, status = 'launched', updated_at = now()
        where org_id = $1`,
      [input.orgId, diditSessionId],
    );
    if (!upd.rowCount) {
      await pool.query(
        `insert into didit_verifications (org_id, didit_session_id, status) values ($1, $2, 'launched')`,
        [input.orgId, diditSessionId],
      );
    }
    return { diditSessionId, hostedUrl: `mock://didit/${input.orgId}` };
  }
}
