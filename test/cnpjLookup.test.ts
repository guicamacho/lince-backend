/** CNPJ lookup — pure pieces only, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCnpj, checkRateLimit, mapCnpjResponse } from "../src/modules/onboarding/cnpjLookup.js";

test("normalizeCnpj strips punctuation; rejects wrong length", () => {
  assert.equal(normalizeCnpj("11.222.333/0001-81"), "11222333000181");
  assert.throws(() => normalizeCnpj("123"), /cnpj_invalid/);
  assert.throws(() => normalizeCnpj(""), /cnpj_invalid/);
});

test("rate guard: 10/min per user, the 11th trips", () => {
  const uid = `user_${Math.random()}`;
  const now = 1_700_000_000_000; // fixed window so the 11 calls can't straddle a boundary
  for (let i = 0; i < 10; i++) checkRateLimit(uid, now);
  assert.throws(() => checkRateLimit(uid, now), /rate_limited/);
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
