/**
 * Export-audit sink (A1 / PRD-04 §3 "exports are audited"). The admin grid builds the CSV
 * client-side (from rows it already holds) and fires this to record that an export happened.
 *
 * ponytail: no server-side streaming/permission-filtered export pipeline — add that when
 * data volume or column-level permissions demand it. This just writes the audit row.
 */
import { pool } from "../../db/pool.js";

export interface RecordAuditExportInput {
  adminId: string;
  entity: string;
  filter: unknown;
  rowCount: number;
}

export async function recordAuditExport(input: RecordAuditExportInput): Promise<void> {
  await pool.query(
    `insert into audit_log (actor_type, actor_id, event, payload)
     values ('ops', $1, 'admin.export', $2)`,
    [input.adminId, JSON.stringify({ entity: input.entity, filter: input.filter, row_count: input.rowCount })],
  );
}
