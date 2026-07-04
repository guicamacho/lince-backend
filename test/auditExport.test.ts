/** Export-audit sink (A1): recordAuditExport writes an admin.export audit row. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { recordAuditExport } from "../src/modules/admin/auditExport.js";
import { resetDb, createAdmin } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("records an admin.export audit row with entity / filter / row_count", async () => {
  const admin = await createAdmin();
  await recordAuditExport({ adminId: admin, entity: "orgs", filter: { status: "active" }, rowCount: 42 });

  const { rows } = await pool.query(
    "select actor_type, actor_id, payload from audit_log where event = 'admin.export'",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, "ops");
  assert.equal(rows[0].actor_id, admin);
  assert.equal(rows[0].payload.entity, "orgs");
  assert.equal(rows[0].payload.row_count, 42);
  assert.deepEqual(rows[0].payload.filter, { status: "active" });
});
