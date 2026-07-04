/** CNPJ lookup — pure pieces only, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCnpj, mapCnpjResponse } from "../src/modules/onboarding/cnpjLookup.js";

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
