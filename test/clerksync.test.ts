import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { linkClerkUserFromEvent, type ClerkUserEvent } from "../src/modules/identity/clerkSync.js";
import { resetDb } from "./helpers.js";

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
