/** orgs_cnpj_active_uq (migration 0010): CNPJ uniqueness only over NON-terminal states.
 *  Blocks a second live org; allows re-onboarding after declined / rejected / soft-delete
 *  (voluntary closure = deleted_at). PRD-07 §2 pattern 9 + open item #5. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

async function insertOrg(cnpj: string, state = "pending_lince_approval"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into orgs (cnpj, razao_social, country_code, state) values ($1, 'Dup Ltda', 'BR', $2) returning id`,
    [cnpj, state],
  );
  return rows[0]!.id;
}

test("blocks a second LIVE org with the same CNPJ", async () => {
  const cnpj = "22333444000155";
  await insertOrg(cnpj);
  await assert.rejects(insertOrg(cnpj), /orgs_cnpj_active_uq/);
});

test("allows re-onboarding after the prior org was declined", async () => {
  const cnpj = "33444555000144";
  const first = await insertOrg(cnpj, "declined"); // terminal -> excluded from the index
  const second = await insertOrg(cnpj, "pending_lince_approval");
  assert.notEqual(first, second);
});

test("allows re-onboarding after the prior org was rejected", async () => {
  const cnpj = "55666777000122";
  await insertOrg(cnpj, "rejected"); // terminal -> excluded
  const ok = await insertOrg(cnpj, "pending_lince_approval");
  assert.ok(ok);
});

test("allows re-onboarding after voluntary closure (soft-delete)", async () => {
  const cnpj = "44555666000133";
  const first = await insertOrg(cnpj);
  await pool.query("update orgs set deleted_at = now() where id = $1", [first]); // deleted_at -> excluded
  const second = await insertOrg(cnpj);
  assert.notEqual(first, second);
});
