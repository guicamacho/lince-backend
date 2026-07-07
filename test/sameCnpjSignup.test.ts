/** PRD-07 §2 pattern 9 (concurrency test 4): two concurrent signups with the same CNPJ.
 *  The org-onboarding advisory lock + orgs_cnpj_active_uq yield exactly one org; the other
 *  routes to the existing duplicate path (cnpj_already_registered). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
const complete = (cnpj: string) => ({
  cnpj,
  razaoSocial: "Concorrente Ltda",
  role: "CEO",
  fullName: "Representante",
  email: `${clerkId()}@race.test`,
});

test("two concurrent same-CNPJ signups -> one org created, one cnpj_already_registered", async () => {
  const cnpj = "11222333000181";
  // DIFFERENT clerk users, same CNPJ, fired together on two pool clients.
  const results = await Promise.allSettled([
    bootstrapOrgForClerkUser(clerkId(), complete(cnpj)),
    bootstrapOrgForClerkUser(clerkId(), complete(cnpj)),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one signup created an org");
  assert.equal(failed.length, 1);
  assert.match(String((failed[0] as PromiseRejectedResult).reason), /cnpj_already_registered/);

  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from orgs where cnpj = $1",
    [cnpj],
  );
  assert.equal(rows[0]!.n, 1, "only one org row exists for the CNPJ");
});
