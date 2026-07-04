/** CNPJ lookup — pure pieces + the live-org duplicate check; no network. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { normalizeCnpj, mapCnpjResponse, isCnpjRegistered } from "../src/modules/onboarding/cnpjLookup.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

// The per-user rate guard moved out of this module to the rateLimit("cnpj_lookup")
// middleware (WP-B13); it's covered by test/rateLimiter.test.ts now.

test("normalizeCnpj strips punctuation; rejects wrong length", () => {
  assert.equal(normalizeCnpj("11.222.333/0001-81"), "11222333000181");
  assert.throws(() => normalizeCnpj("123"), /cnpj_invalid/);
  assert.throws(() => normalizeCnpj(""), /cnpj_invalid/);
});

test("mapCnpjResponse: code 2 or label ATIVA => ativa true", () => {
  assert.deepEqual(mapCnpjResponse({ razao_social: "Acme Ltda", situacao_cadastral: 2 }), {
    razaoSocial: "Acme Ltda",
    ativa: true,
  });
  assert.deepEqual(mapCnpjResponse({ razao_social: "Acme Ltda", descricao_situacao_cadastral: "ATIVA" }), {
    razaoSocial: "Acme Ltda",
    ativa: true,
  });
  assert.equal(mapCnpjResponse({ razao_social: "Acme Ltda" }).ativa, false);
});

test("mapCnpjResponse: empty razão social throws cnpj_no_name", () => {
  assert.throws(() => mapCnpjResponse({ razao_social: "   " }), /cnpj_no_name/);
  assert.throws(() => mapCnpjResponse({}), /cnpj_no_name/);
});

test("isCnpjRegistered: live org true; denylist-only and unknown false", async () => {
  const orgId = await createOrg("active");
  const { rows } = await pool.query<{ cnpj: string }>("select cnpj from orgs where id = $1", [orgId]);
  assert.equal(await isCnpjRegistered(rows[0]!.cnpj), true);

  // Denylisted-but-never-registered must NOT be flagged at lookup time (tipping-off-safe).
  await pool.query("insert into cnpj_denylist (cnpj, reason_ref) values ('99887766000155', 'audit:test')");
  assert.equal(await isCnpjRegistered("99887766000155"), false);

  assert.equal(await isCnpjRegistered("00000000000000"), false);
});
