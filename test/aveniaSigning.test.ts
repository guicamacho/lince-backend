import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { signAveniaRequest, aveniaSignedHeaders } from "../src/modules/providers/avenia/signing.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function verify(stringToSign: string, signatureB64: string): boolean {
  const v = createVerify("RSA-SHA256");
  v.update(stringToSign);
  v.end();
  return v.verify(publicKeyPem, signatureB64, "base64");
}

test("signs the FULL requestUri incl. query string; the same signature does NOT verify over the bare path", () => {
  const requestUri = "/v2/account/quote/fixed-rate?subAccountId=abc123";
  const { signature } = signAveniaRequest({ method: "get", requestUri, privateKeyPem, timestamp: "1700000000000" });
  // method upper-cased, timestamp + method + full uri + empty body
  assert.equal(verify("1700000000000GET" + requestUri, signature), true);
  // strip the query string -> verification must fail (proves query is signed)
  assert.equal(verify("1700000000000GET/v2/account/quote/fixed-rate", signature), false);
});

test("body is materially included in the signature", () => {
  const base = { method: "POST", requestUri: "/v2/account/tickets?subAccountId=x", privateKeyPem, timestamp: "1700000000000" };
  const body = '{"quoteToken":"q"}';
  const { signature } = signAveniaRequest({ ...base, body });
  assert.equal(verify("1700000000000POST/v2/account/tickets?subAccountId=x" + body, signature), true);
  // same signature without the body appended must fail
  assert.equal(verify("1700000000000POST/v2/account/tickets?subAccountId=x", signature), false);
});

test("auto timestamp is a 13-digit ms string; an explicit timestamp is echoed back verbatim", () => {
  const auto = signAveniaRequest({ method: "GET", requestUri: "/x", privateKeyPem });
  assert.match(auto.timestamp, /^\d{13}$/);
  const echoed = signAveniaRequest({ method: "GET", requestUri: "/x", privateKeyPem, timestamp: "1699999999999" });
  assert.equal(echoed.timestamp, "1699999999999");
});

test("signed headers carry exactly the four expected keys and a verifiable signature", () => {
  const headers = aveniaSignedHeaders("api-key-123", { method: "GET", requestUri: "/x?y=1", privateKeyPem, timestamp: "1700000000000" });
  assert.deepEqual(Object.keys(headers).sort(), ["Content-Type", "X-API-Key", "X-API-Signature", "X-API-Timestamp"]);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-API-Key"], "api-key-123");
  assert.equal(headers["X-API-Timestamp"], "1700000000000");
  assert.equal(verify("1700000000000GET/x?y=1", headers["X-API-Signature"]!), true);
});

test("tampering with the signed message breaks verification", () => {
  const { signature } = signAveniaRequest({ method: "GET", requestUri: "/v2/x?a=1", privateKeyPem, timestamp: "1700000000000" });
  assert.equal(verify("1700000000000GET/v2/x?a=2", signature), false);
});
