/** Avenia inbound webhook verification: RSA-PSS over the raw body, `Signature` header. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, constants } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { receiveWebhook } from "../src/modules/webhooks/inbox.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function pssSign(rawBody: string): string {
  return cryptoSign("sha256", Buffer.from(rawBody, "utf8"), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_MAX_SIGN,
  }).toString("base64");
}

const config = { aveniaPublicKey: async () => publicPem };

function input(rawBody: string, signature: string | undefined, id = "evt-1") {
  return {
    provider: "avenia",
    externalId: id,
    eventType: "TICKET-CREATED",
    rawBody,
    payload: JSON.parse(rawBody),
    headers: { signature },
    config,
  };
}

test("valid PSS signature -> 202 and stored", async () => {
  const raw = JSON.stringify({ id: "evt-1", type: "TICKET-CREATED" });
  const out = await receiveWebhook(input(raw, pssSign(raw)));
  assert.equal(out.status, 202);
  const { rowCount } = await pool.query(
    "select 1 from webhook_events where provider_code = 'avenia' and external_event_id = 'evt-1'",
  );
  assert.equal(rowCount, 1);
});

test("tampered body -> 400 and NOT stored", async () => {
  const raw = JSON.stringify({ id: "evt-2", amount: "100" });
  const sig = pssSign(raw);
  const tampered = JSON.stringify({ id: "evt-2", amount: "999999" });
  const out = await receiveWebhook(input(tampered, sig, "evt-2"));
  assert.equal(out.status, 400);
  const { rowCount } = await pool.query("select 1 from webhook_events where external_event_id = 'evt-2'");
  assert.equal(rowCount, 0);
});

test("missing Signature header -> 400", async () => {
  const raw = JSON.stringify({ id: "evt-3" });
  assert.equal((await receiveWebhook(input(raw, undefined, "evt-3"))).status, 400);
});

test("no public key available -> 503 (fail closed, provider retries)", async () => {
  const raw = JSON.stringify({ id: "evt-4" });
  const out = await receiveWebhook({ ...input(raw, pssSign(raw), "evt-4"), config: {} });
  assert.equal(out.status, 503);
});
