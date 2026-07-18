import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { linkClerkUserFromEvent, recoveryDetected, type ClerkUserEvent } from "../src/modules/identity/clerkSync.js";
import { moneyOutHoldActive } from "../src/modules/access/recoveryHold.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

function userEvent(id: string, email: string, type = "user.created"): ClerkUserEvent {
  return {
    type,
    data: {
      id,
      email_addresses: [{ id: "idn_1", email_address: email }],
      primary_email_address_id: "idn_1",
      first_name: "Maria",
      last_name: "Silva",
    },
  };
}

test("links an existing login-person by email (e.g. a pre-screened legal rep)", async () => {
  const { rows } = await pool.query<{ id: string }>(
    "insert into people (full_name, email, can_login) values ('Maria Silva','maria@acme.com.br',true) returning id",
  );
  const personId = rows[0]!.id;
  const linked = await linkClerkUserFromEvent(userEvent("user_abc", "maria@acme.com.br"));
  assert.equal(linked, personId);
  const check = await pool.query("select clerk_user_id from people where id = $1", [personId]);
  assert.equal(check.rows[0].clerk_user_id, "user_abc");
});

test("creates a new login-person when none matches", async () => {
  const id = await linkClerkUserFromEvent(userEvent("user_new", "new@startup.com"));
  assert.ok(id);
  const check = await pool.query("select clerk_user_id, email, can_login from people where id = $1", [id]);
  assert.equal(check.rows[0].clerk_user_id, "user_new");
  assert.equal(check.rows[0].email, "new@startup.com");
  assert.equal(check.rows[0].can_login, true);
});

test("idempotent: same user twice -> one person, still linked", async () => {
  const a = await linkClerkUserFromEvent(userEvent("user_x", "x@x.com"));
  const b = await linkClerkUserFromEvent(userEvent("user_x", "x@x.com", "user.updated"));
  assert.equal(a, b);
  const count = await pool.query<{ n: number }>("select count(*)::int as n from people where clerk_user_id = 'user_x'");
  assert.equal(count.rows[0]!.n, 1);
});

test("ignores non-user events", async () => {
  const r = await linkClerkUserFromEvent({ type: "session.created", data: { id: "sess_1" } });
  assert.equal(r, null);
});

// --- Cluster 2: the recovery-hold trigger (PRD-07 §3.5) ---

function secEvent(
  id: string,
  email: string,
  sec: { tf: boolean; emailId?: string },
  type = "user.created",
): ClerkUserEvent {
  const emailId = sec.emailId ?? "idn_1";
  return {
    type,
    data: {
      id,
      email_addresses: [{ id: emailId, email_address: email }],
      primary_email_address_id: emailId,
      first_name: "Owner",
      last_name: "Um",
      two_factor_enabled: sec.tf,
    },
  };
}

async function memberOf(personId: string, orgId: string): Promise<void> {
  await pool.query(`insert into org_people (org_id, person_id, roles, status) values ($1,$2,'{owner}','active')`, [
    orgId,
    personId,
  ]);
}

test("recoveryDetected: factor removal or primary-email swap; nothing without a prior snapshot", () => {
  assert.equal(recoveryDetected({ two_factor_enabled: true }, { two_factor_enabled: false }), true);
  assert.equal(
    recoveryDetected(
      { two_factor_enabled: true, primary_email_address_id: "a" },
      { two_factor_enabled: true, primary_email_address_id: "b" },
    ),
    true,
  );
  assert.equal(recoveryDetected({ two_factor_enabled: false }, { two_factor_enabled: false }), false);
  assert.equal(recoveryDetected(null, { two_factor_enabled: false }), false);
  assert.equal(recoveryDetected({ two_factor_enabled: true }, { two_factor_enabled: true }), false);
});

test("factor removal registers the 24h hold on EVERY org + notifies once; redelivery adds nothing", async () => {
  const personId = (await linkClerkUserFromEvent(secEvent("user_rec", "owner@empresa.com.br", { tf: true })))!;
  const org1 = await createOrg("active");
  const org2 = await createOrg("active");
  await memberOf(personId, org1);
  await memberOf(personId, org2);

  await linkClerkUserFromEvent(secEvent("user_rec", "owner@empresa.com.br", { tf: false }, "user.updated"));
  assert.equal(await moneyOutHoldActive(org1), true);
  assert.equal(await moneyOutHoldActive(org2), true);
  const mail = await pool.query(
    "select recipient_ref from notification_outbox where event_type = 'post_recovery_hold'",
  );
  assert.deepEqual(mail.rows.map((r) => r.recipient_ref), ["owner@empresa.com.br"]);

  // Redelivery of the SAME event: snapshot already matches -> no new hold rows, no new mail.
  await linkClerkUserFromEvent(secEvent("user_rec", "owner@empresa.com.br", { tf: false }, "user.updated"));
  const holds = await pool.query(
    "select count(*)::int as n from audit_log where event = 'security.post_recovery_hold'",
  );
  assert.equal(holds.rows[0]!.n, 2, "one hold per org, not re-registered on redelivery");
  const mail2 = await pool.query("select count(*)::int as n from notification_outbox where event_type = 'post_recovery_hold'");
  assert.equal(mail2.rows[0]!.n, 1);
});

test("primary-email swap triggers the hold and notifies BOTH the stored and the new address", async () => {
  const personId = (await linkClerkUserFromEvent(secEvent("user_swp", "real@empresa.com.br", { tf: true })))!;
  const orgId = await createOrg("active");
  await memberOf(personId, orgId);

  await linkClerkUserFromEvent(
    secEvent("user_swp", "attacker@evil.com", { tf: true, emailId: "idn_2" }, "user.updated"),
  );
  assert.equal(await moneyOutHoldActive(orgId), true);
  const mail = await pool.query<{ recipient_ref: string }>(
    "select recipient_ref from notification_outbox where event_type = 'post_recovery_hold' order by recipient_ref",
  );
  assert.deepEqual(mail.rows.map((r) => r.recipient_ref), ["attacker@evil.com", "real@empresa.com.br"]);
  // The stored contact stays the pre-swap one — resolution keeps mailing the real owner.
  const person = await pool.query("select email from people where id = $1", [personId]);
  assert.equal(person.rows[0].email, "real@empresa.com.br");
});

test("user.created only seeds the snapshot — a brand-new user never starts held", async () => {
  const personId = (await linkClerkUserFromEvent(secEvent("user_fresh", "f@x.com", { tf: false })))!;
  const orgId = await createOrg("active");
  await memberOf(personId, orgId);
  assert.equal(await moneyOutHoldActive(orgId), false);
  const snap = await pool.query("select security_snapshot from people where id = $1", [personId]);
  assert.equal(snap.rows[0].security_snapshot.two_factor_enabled, false);
});
