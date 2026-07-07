/** PRD-07 §2 pattern 10 (concurrency test 5): two concurrent role adds on one org_people row.
 *  The SELECT ... FOR UPDATE row lock serialises the read-modify-write so neither add is lost. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { addOrgPersonRoles } from "../src/modules/team/roles.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

async function seedMember(): Promise<{ orgId: string; personId: string }> {
  const orgId = await createOrg();
  const { rows } = await pool.query<{ id: string }>(
    `insert into people (full_name, email, can_login) values ('Membro', $1, true) returning id`,
    [`m+${Date.now()}${Math.floor(Math.random() * 1e9)}@team.test`],
  );
  const personId = rows[0]!.id;
  await pool.query(
    `insert into org_people (org_id, person_id, roles, status) values ($1, $2, '{viewer}', 'active')`,
    [orgId, personId],
  );
  return { orgId, personId };
}

test("two concurrent role adds -> both roles present (no lost update)", async () => {
  const { orgId, personId } = await seedMember();

  await Promise.all([
    addOrgPersonRoles(orgId, personId, ["finance"]),
    addOrgPersonRoles(orgId, personId, ["admin"]),
  ]);

  const { rows } = await pool.query<{ roles: string[] }>(
    `select roles from org_people where org_id = $1 and person_id = $2`,
    [orgId, personId],
  );
  const roles = rows[0]!.roles;
  assert.ok(roles.includes("viewer"), "kept the pre-existing role");
  assert.ok(roles.includes("finance"), "kept the first concurrent add");
  assert.ok(roles.includes("admin"), "kept the second concurrent add");
});

test("adding an existing role is idempotent (set-merge, no duplicates)", async () => {
  const { orgId, personId } = await seedMember();
  const roles = await addOrgPersonRoles(orgId, personId, ["viewer", "finance"]);
  assert.deepEqual([...roles].sort(), ["finance", "viewer"]);
});
