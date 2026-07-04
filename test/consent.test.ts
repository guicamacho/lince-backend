/** Versioned ToS acceptance: bootstrap writes ONE consent.accepted row per org (idempotent). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { bootstrapOrgForClerkUser } from "../src/modules/onboarding/bootstrap.js";
import { CONSENT_VERSIONS } from "../src/modules/onboarding/consent.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

const clerkId = () => `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

test("bootstrap writes one consent.accepted row with the version set; re-bootstrap does not double-write", async () => {
  const uid = clerkId();
  const input = {
    cnpj: "11.222.333/0001-81",
    razaoSocial: "Acme Pagamentos Ltda",
    role: "CEO",
    fullName: "Maria Souza",
    email: `maria+${uid}@acme.test`,
  };
  const { orgId } = await bootstrapOrgForClerkUser(uid, input);

  const first = await pool.query(
    "select actor_type, actor_id, payload from audit_log where org_id = $1 and event = 'consent.accepted'",
    [orgId],
  );
  assert.equal(first.rowCount, 1);
  assert.equal(first.rows[0].actor_type, "user");
  const docs = first.rows[0].payload.documents as Array<{ id: string; version: string }>;
  assert.deepEqual(docs.map((d) => d.id).sort(), ["avenia_terms", "lgpd_consent", "lince_channel_terms"]);
  const byId = Object.fromEntries(docs.map((d) => [d.id, d.version]));
  assert.equal(byId.avenia_terms, CONSENT_VERSIONS.avenia_terms);
  assert.equal(byId.lince_channel_terms, CONSENT_VERSIONS.lince_channel_terms);
  assert.equal(byId.lgpd_consent, CONSENT_VERSIONS.lgpd_consent);
  assert.ok(first.rows[0].payload.acceptedAt, "acceptedAt recorded");

  // Idempotent re-call (same user) short-circuits before the org branch -> no second row.
  await bootstrapOrgForClerkUser(uid, input);
  const again = await pool.query(
    "select count(*)::int as n from audit_log where org_id = $1 and event = 'consent.accepted'",
    [orgId],
  );
  assert.equal(again.rows[0].n, 1);
});
