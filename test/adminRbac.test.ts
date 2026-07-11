/** Admin RBAC (PRD-08 §5.1): the role-gate middleware logic + staff role management. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers.js";
import { requireAdminRole, requireAdminAccess, resolveVerifiedAdmin } from "../src/modules/access/adminActor.js";
import { setAdminRoles, listAdmins } from "../src/modules/admin/staff.js";
import { HttpError } from "../src/http/error.js";

beforeEach(resetDb);
after(() => pool.end());

// Minimal res stub carrying res.locals.adminActor; captures what the middleware passes to next().
function runGate(roles: string[] | null, verified: boolean, allowed: Parameters<typeof requireAdminRole>) {
  const res = { locals: roles ? { adminActor: { adminId: "a", roles, verified } } : {} } as unknown as Response;
  let called: "ok" | Error = "ok";
  requireAdminRole(...allowed)({} as never, res, (err?: unknown) => {
    if (err) called = err as Error;
  });
  return called;
}

test("requireAdminRole: verified actors are gated by role; superadmin always passes", () => {
  assert.equal(runGate(["compliance"], true, ["compliance"]), "ok");
  assert.equal(runGate(["superadmin"], true, ["compliance"]), "ok"); // superadmin bypass
  assert.ok(runGate(["support"], true, ["compliance"]) instanceof HttpError); // wrong role -> 403
  assert.equal((runGate(["support"], true, ["compliance"]) as HttpError).statusCode, 403);
  assert.ok(runGate([], true, ["compliance"]) instanceof HttpError); // no roles -> 403
  assert.ok(runGate([], true, []) instanceof HttpError); // superadmin-only route, plain admin -> 403
});

test("requireAdminRole: legacy (unverified) mode is permissive — enforcement needs the verified path", () => {
  assert.equal(runGate(["support"], false, ["compliance"]), "ok"); // unverified actor
  assert.equal(runGate(null, false, ["compliance"]), "ok"); // no actor at all (reads)
});

test("requireAdminAccess: a verified admin with ZERO roles is denied every /admin route (incl. reads)", () => {
  function runAccess(roles: string[] | null, verified: boolean) {
    const res = { locals: roles ? { adminActor: { adminId: "a", roles, verified } } : {} } as unknown as Response;
    let called: "ok" | Error = "ok";
    requireAdminAccess({} as never, res, (err?: unknown) => {
      if (err) called = err as Error;
    });
    return called;
  }
  assert.ok(runAccess([], true) instanceof HttpError); // verified but no roles -> 403 (no PII reads)
  assert.equal((runAccess([], true) as HttpError).statusCode, 403);
  assert.equal(runAccess(["read_only"], true), "ok"); // any role passes the baseline
  assert.equal(runAccess([], false), "ok"); // legacy mode: permissive
  assert.equal(runAccess(null, false), "ok");
});

async function makeAdmin(email: string, roles: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into admin_users (email, name, roles) values ($1, $1, $2) returning id`,
    [email, roles],
  );
  return rows[0]!.id;
}

test("resolveVerifiedAdmin: a rehired-but-still-inactive admin cannot act, and keeps no old roles implicitly", async () => {
  // offboarded: is_active=false, still holds compliance, old clerk id
  await pool.query(
    `insert into admin_users (clerk_user_id, email, name, roles, is_active) values ('clerk_old', 'ana@l.test', 'Ana', '{compliance}', false)`,
  );
  // rehire on the invite-only admin instance -> new sub, same email -> ensureAdminUser relinks by email
  const fetchUser = async () => ({ email: "ana@l.test", name: "Ana" });
  await assert.rejects(
    resolveVerifiedAdmin("clerk_new", fetchUser),
    (e) => e instanceof HttpError && e.statusCode === 403, // admin_inactive — no resurrection on relink
  );
  // an ACTIVE admin resolves with their roles
  await pool.query(`update admin_users set is_active = true where email = 'ana@l.test'`);
  const actor = await resolveVerifiedAdmin("clerk_new", fetchUser);
  assert.deepEqual(actor.roles, ["compliance"]);
  assert.equal(actor.verified, true);
});

test("resolveVerifiedAdmin: a brand-new verified admin provisions with EMPTY roles (no privileges)", async () => {
  const actor = await resolveVerifiedAdmin("clerk_fresh", async () => ({ email: "new@l.test", name: "New" }));
  assert.deepEqual(actor.roles, []);
});

test("setAdminRoles: sets valid roles, drops unknown ones, audits", async () => {
  const superId = await makeAdmin("super@l.test", ["superadmin"]);
  const target = await makeAdmin("t@l.test", []);
  const updated = await setAdminRoles(target, ["compliance", "not_a_role", "support"], superId);
  assert.deepEqual([...updated!.roles].sort(), ["compliance", "support"]);
  const audit = await pool.query(`select 1 from audit_log where event='admin.roles_changed' and actor_id=$1`, [superId]);
  assert.equal(audit.rowCount, 1);
  await assert.rejects(setAdminRoles("00000000-0000-0000-0000-000000000000", ["support"], superId),
    (e) => e instanceof HttpError && e.statusCode === 404);
});

test("setAdminRoles: refuses to strip the last active superadmin (lockout guard)", async () => {
  const onlySuper = await makeAdmin("only@l.test", ["superadmin"]);
  await assert.rejects(setAdminRoles(onlySuper, ["compliance"], onlySuper),
    (e) => e instanceof HttpError && e.statusCode === 409);
  // with a second superadmin, demoting one is allowed
  const second = await makeAdmin("second@l.test", ["superadmin"]);
  const demoted = await setAdminRoles(onlySuper, ["compliance"], second);
  assert.deepEqual(demoted!.roles, ["compliance"]);
  assert.equal((await listAdmins()).length, 2);
});
