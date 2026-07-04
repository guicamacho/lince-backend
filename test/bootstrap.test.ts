/** Org bootstrap re-submission controls: denylist + duplicate-CNPJ (DB). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const complete = (cnpj: string) => ({
  cnpj,
  razaoSocial: "Recusada Ltda",
  role: "CEO",
  fullName: "Representante",
  email: `${clerkId()}@boot.test`,
});

test("bootstrap rejects a denylisted CNPJ (fresh clerk user reaches the check)", async () => {
  const cnpj = "11222333000181";
  await pool.query("insert into cnpj_denylist (cnpj, reason_ref) values ($1, 'test')", [cnpj]);
  // A fresh user has no live org, so the same-user idempotent early-return doesn't
  // fire and execution reaches the denylist check.
  await assert.rejects(bootstrapOrgForClerkUser(clerkId(), complete(cnpj)), /cnpj_denylisted/);
});

test("bootstrap rejects the same CNPJ from a DIFFERENT clerk user", async () => {
  const cnpj = "99888777000166";
  await bootstrapOrgForClerkUser(clerkId(), complete(cnpj));
  // Must be a different user: the same user would short-circuit on the idempotent
  // "one org per signup" early-return before ever reaching the duplicate check.
  await assert.rejects(bootstrapOrgForClerkUser(clerkId(), complete(cnpj)), /cnpj_already_registered/);
});
