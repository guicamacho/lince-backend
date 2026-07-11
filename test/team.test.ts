/** Team management (PRD-03 F1/F3/F7): invite, role change, remove, transfer, gate visibility. */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { resetDb, createOrg } from "./helpers.js";
import {
  listMembers,
  inviteMember,
  resendInvitation,
  changeMemberRole,
  removeMember,
  transferOwnership,
  INVITE_COOLDOWN_SECONDS,
} from "../src/modules/team/team.service.js";
import { isDuplicateInvitation } from "../src/modules/team/clerkInvitations.js";
import { activeMembershipForClerkUser } from "../src/modules/access/orgContext.js";
import { linkClerkUserFromEvent, ensureClerkUserLinked } from "../src/modules/identity/clerkSync.js";
import { inviteRedirectUrl } from "../src/modules/team/clerkInvitations.js";
import { HttpError } from "../src/http/error.js";

beforeEach(resetDb);
after(() => pool.end());

let seq = 0;
async function makePerson(email: string, clerkUserId: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into people (full_name, email, can_login, clerk_user_id) values ($1, $2, true, $3) returning id`,
    [email.split("@")[0], email, clerkUserId],
  );
  return rows[0]!.id;
}
async function addMembership(orgId: string, personId: string, roles: string[], status = "active"): Promise<void> {
  await pool.query(`insert into org_people (org_id, person_id, roles, status) values ($1,$2,$3,$4)`, [
    orgId,
    personId,
    roles,
    status,
  ]);
}
async function activeOrgWithOwner(): Promise<{ orgId: string; ownerId: string }> {
  const orgId = await createOrg("active");
  const ownerId = await makePerson(`owner${seq++}@t.test`, `clerk_o${seq}`);
  await addMembership(orgId, ownerId, ["owner", "legal_rep"]);
  return { orgId, ownerId };
}
const noInvite = async () => {};

test("listMembers: owner first, KYB tags hidden, pure-KYB rows excluded", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const fin = await makePerson("fin@t.test");
  await addMembership(orgId, fin, ["finance"]);
  const ubo = await makePerson("ubo@t.test");
  await addMembership(orgId, ubo, ["ubo"]); // compliance record, not a team member
  const members = await listMembers(orgId);
  assert.deepEqual(members.map((m) => m.personId), [ownerId, fin]);
  assert.deepEqual(members[0]!.roles, ["owner"]); // legal_rep never surfaced
});

test("listMembers: cooldownRemaining reflects last_invited_at (0 when never invited)", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const fresh = await makePerson("fresh@t.test");
  await addMembership(orgId, fresh, ["viewer"], "invited"); // no last_invited_at
  await inviteMember(orgId, ownerId, { email: "just@t.test", role: "viewer" }, noInvite); // sets last_invited_at now
  const byId = Object.fromEntries((await listMembers(orgId)).map((m) => [m.email, m.cooldownRemaining]));
  assert.equal(byId["fresh@t.test"], 0);
  assert.ok(byId["just@t.test"] > 0 && byId["just@t.test"] <= INVITE_COOLDOWN_SECONDS);
  assert.equal(byId[/* owner */ Object.keys(byId).find((e) => e.startsWith("owner"))!], 0);
});

test("invite: new email -> person + invited membership + Clerk invitation + audit", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const sent: string[] = [];
  const m = await inviteMember(orgId, ownerId, { email: "Nova@Empresa.Test", role: "finance" }, async (e) => {
    sent.push(e);
  });
  assert.deepEqual(sent, ["nova@empresa.test"]);
  assert.equal(m.status, "invited");
  assert.deepEqual(m.roles, ["finance"]);
  const audit = await pool.query(`select 1 from audit_log where org_id = $1 and event = 'team.invited'`, [orgId]);
  assert.equal(audit.rowCount, 1);
  // invited members do NOT pass the /app gate resolver
  const row = await pool.query<{ status: string }>(
    `select status from org_people where org_id = $1 and person_id = $2`,
    [orgId, m.personId],
  );
  assert.equal(row.rows[0]!.status, "invited");
});

test("invite: existing Clerk person (multi-org) -> active immediately, no Clerk invitation", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const otherOrg = await createOrg("active");
  const existing = await makePerson("multi@t.test", "clerk_multi");
  await addMembership(otherOrg, existing, ["owner"]);
  let sent = 0;
  const m = await inviteMember(orgId, ownerId, { email: "multi@t.test", role: "viewer" }, async () => {
    sent += 1;
  });
  assert.equal(sent, 0);
  assert.equal(m.status, "active");
  assert.equal(m.personId, existing); // same person, new org_people row only
});

test("invite: already a member -> 409; owner role -> 422; bad email -> 422", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const fin = await makePerson("fin2@t.test");
  await addMembership(orgId, fin, ["finance"]);
  await assert.rejects(
    inviteMember(orgId, ownerId, { email: "fin2@t.test", role: "viewer" }, noInvite),
    (e) => e instanceof HttpError && e.statusCode === 409,
  );
  await assert.rejects(
    inviteMember(orgId, ownerId, { email: "x@t.test", role: "owner" }, noInvite),
    (e) => e instanceof HttpError && e.statusCode === 422,
  );
  await assert.rejects(
    inviteMember(orgId, ownerId, { email: "not-an-email", role: "viewer" }, noInvite),
    (e) => e instanceof HttpError && e.statusCode === 422,
  );
});

test("invite: Clerk delivery failure compensates the invited row (502, nothing lingers)", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  await assert.rejects(
    inviteMember(orgId, ownerId, { email: "ghost@t.test", role: "viewer" }, async () => {
      throw new Error("clerk down");
    }),
    (e) => e instanceof HttpError && e.statusCode === 502,
  );
  const rows = await pool.query(
    `select 1 from org_people op join people p on p.id = op.person_id where op.org_id = $1 and lower(p.email) = 'ghost@t.test'`,
    [orgId],
  );
  assert.equal(rows.rowCount, 0);
});

test("invite: sender resolving (Clerk duplicate_record treated as success in app.ts) keeps the invited row", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  // A resolving sender is the shape sendClerkInvitation returns on a Clerk duplicate_record 4xx
  // (invitation already exists / will still be delivered). The membership must NOT be compensated.
  await inviteMember(orgId, ownerId, { email: "dup@t.test", role: "viewer" }, noInvite);
  const rows = await pool.query<{ status: string }>(
    `select op.status from org_people op join people p on p.id = op.person_id
      where op.org_id = $1 and lower(p.email) = 'dup@t.test'`,
    [orgId],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0]!.status, "invited");
});

// Backdate a person's last-invite so the cooldown has elapsed (avoids waiting in tests).
async function clearCooldown(email: string): Promise<void> {
  await pool.query(
    `update people set last_invited_at = now() - make_interval(secs => $1) where lower(email) = $2`,
    [INVITE_COOLDOWN_SECONDS + 5, email.toLowerCase()],
  );
}

test("resendInvitation: invited member re-sends, audits, then hits the cooldown until it elapses", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const p = await makePerson("pending@t.test");
  await addMembership(orgId, p, ["viewer"], "invited");
  const sent: string[] = [];
  const send = async (e: string) => {
    sent.push(e);
  };
  await resendInvitation(orgId, ownerId, p, send);
  assert.deepEqual(sent, ["pending@t.test"]);
  const audit = await pool.query(`select 1 from audit_log where org_id=$1 and event='team.invitation_resent'`, [orgId]);
  assert.equal(audit.rowCount, 1);
  // immediate second resend is cooled down
  await assert.rejects(resendInvitation(orgId, ownerId, p, send), (e) => e instanceof HttpError && e.statusCode === 429);
  assert.equal(sent.length, 1); // sender NOT called on the cooled-down attempt
  // after the cooldown elapses it sends again
  await clearCooldown("pending@t.test");
  await resendInvitation(orgId, ownerId, p, send);
  assert.equal(sent.length, 2);
});

test("resendInvitation: a failed send releases the cooldown so retry isn't blocked", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const p = await makePerson("retry@t.test");
  await addMembership(orgId, p, ["viewer"], "invited");
  const fail = async () => {
    throw new Error("clerk down");
  };
  await assert.rejects(resendInvitation(orgId, ownerId, p, fail), (e) => e instanceof HttpError && e.statusCode === 502);
  // cooldown was restored (null) -> an immediate retry is NOT throttled
  const sent: string[] = [];
  await resendInvitation(orgId, ownerId, p, async (e) => {
    sent.push(e);
  });
  assert.deepEqual(sent, ["retry@t.test"]);
});

test("resendInvitation: rejects an active member (422) and an unknown person (404)", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const active = await makePerson("act@t.test", "clerk_act");
  await addMembership(orgId, active, ["finance"], "active");
  await assert.rejects(resendInvitation(orgId, ownerId, active, noInvite), (e) => e instanceof HttpError && e.statusCode === 422);
  await assert.rejects(
    resendInvitation(orgId, ownerId, "00000000-0000-0000-0000-000000000000", noInvite),
    (e) => e instanceof HttpError && e.statusCode === 404,
  );
});

test("removeMember: revokes the pending Clerk invite for an invited member, not for an active one", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const invited = await makePerson("inv@t.test");
  await addMembership(orgId, invited, ["viewer"], "invited");
  const active = await makePerson("act2@t.test", "clerk_act2");
  await addMembership(orgId, active, ["finance"], "active");
  const revoked: string[] = [];
  const revoke = async (e: string) => {
    revoked.push(e);
  };
  await removeMember(orgId, ownerId, invited, revoke);
  await removeMember(orgId, ownerId, active, revoke);
  assert.deepEqual(revoked, ["inv@t.test"]); // only the invited member's invite is revoked
});

test("invite cooldown survives removal: remove + immediate re-invite is throttled, then allowed", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const sent: string[] = [];
  const send = async (e: string) => {
    sent.push(e);
  };
  const m = await inviteMember(orgId, ownerId, { email: "g@t.test", role: "viewer" }, send);
  await removeMember(orgId, ownerId, m.personId, noInvite);
  // people row (and last_invited_at) persists across removal -> re-invite is cooled down
  await assert.rejects(
    inviteMember(orgId, ownerId, { email: "g@t.test", role: "viewer" }, send),
    (e) => e instanceof HttpError && e.statusCode === 429,
  );
  assert.equal(sent.length, 1);
  // no dangling invited-but-never-emailed row from the throttled attempt
  const rows = await pool.query(
    `select 1 from org_people op join people p on p.id=op.person_id where op.org_id=$1 and lower(p.email)='g@t.test'`,
    [orgId],
  );
  assert.equal(rows.rowCount, 0);
  await clearCooldown("g@t.test");
  await inviteMember(orgId, ownerId, { email: "g@t.test", role: "viewer" }, send);
  assert.equal(sent.length, 2);
});

test("isDuplicateInvitation: only a 4xx duplicate_record is a success; 5xx and other 4xx throw", () => {
  const dup = { errors: [{ code: "duplicate_record" }] };
  assert.equal(isDuplicateInvitation(422, dup), true); // already invited -> keep the membership
  assert.equal(isDuplicateInvitation(400, dup), true);
  assert.equal(isDuplicateInvitation(500, dup), false); // 5xx is a genuine failure even if body looks dup
  assert.equal(isDuplicateInvitation(429, { errors: [{ code: "rate_limit_exceeded" }] }), false); // real failure -> compensate
  assert.equal(isDuplicateInvitation(422, { errors: [{ code: "form_param_missing" }] }), false);
  assert.equal(isDuplicateInvitation(422, null), false);
  assert.equal(isDuplicateInvitation(200, dup), false); // 2xx handled before this is called
});

test("changeMemberRole: swaps the access role, preserves KYB tags, protects the owner", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const member = await makePerson("m@t.test");
  await addMembership(orgId, member, ["viewer", "director"]);
  const roles = await changeMemberRole(orgId, ownerId, member, "admin");
  assert.deepEqual(roles, ["admin"]);
  const raw = await pool.query<{ roles: string[] }>(
    `select roles from org_people where org_id = $1 and person_id = $2`,
    [orgId, member],
  );
  assert.deepEqual([...raw.rows[0]!.roles].sort(), ["admin", "director"]); // tag intact
  await assert.rejects(
    changeMemberRole(orgId, member, ownerId, "viewer"),
    (e) => e instanceof HttpError && e.statusCode === 403, // owner_protected
  );
});

test("removeMember: deletes the row + audits; owner protected", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const member = await makePerson("gone@t.test");
  await addMembership(orgId, member, ["viewer"]);
  await removeMember(orgId, ownerId, member);
  const rows = await pool.query(`select 1 from org_people where org_id = $1 and person_id = $2`, [orgId, member]);
  assert.equal(rows.rowCount, 0);
  const audit = await pool.query(`select 1 from audit_log where org_id = $1 and event = 'team.removed'`, [orgId]);
  assert.equal(audit.rowCount, 1);
  await assert.rejects(removeMember(orgId, member, ownerId), (e) => e instanceof HttpError && e.statusCode === 403);
});

test("transferOwnership: demote-then-promote in one tx; target must be an active admin", async () => {
  const { orgId, ownerId } = await activeOrgWithOwner();
  const adm = await makePerson("adm@t.test", "clerk_adm");
  await addMembership(orgId, adm, ["admin"]);
  await transferOwnership(orgId, ownerId, adm);
  const roles = async (pid: string) =>
    (await pool.query<{ roles: string[] }>(`select roles from org_people where org_id=$1 and person_id=$2`, [orgId, pid]))
      .rows[0]!.roles;
  assert.equal((await roles(ownerId)).includes("owner"), false);
  assert.equal((await roles(ownerId)).includes("admin"), true); // demoted, legal_rep tag rides along
  assert.equal((await roles(adm)).includes("owner"), true);
  const audit = await pool.query(`select 1 from audit_log where org_id = $1 and event = 'ownership.transferred'`, [orgId]);
  assert.equal(audit.rowCount, 1);
  // viewer target rejected; self rejected; non-owner actor rejected
  const viewer = await makePerson("v@t.test");
  await addMembership(orgId, viewer, ["viewer"]);
  await assert.rejects(transferOwnership(orgId, adm, viewer), (e) => e instanceof HttpError && e.statusCode === 422);
  await assert.rejects(transferOwnership(orgId, adm, adm), (e) => e instanceof HttpError && e.statusCode === 422);
  await assert.rejects(transferOwnership(orgId, ownerId, adm), (e) => e instanceof HttpError && e.statusCode === 403); // no longer owner
});

test("gate resolver: invited/suspended memberships do not resolve; active does, with roles", async () => {
  const { orgId } = await activeOrgWithOwner();
  const invited = await makePerson("inv@t.test", "clerk_inv");
  await addMembership(orgId, invited, ["finance"], "invited");
  assert.equal(await activeMembershipForClerkUser("clerk_inv"), null);
  await pool.query(`update org_people set status = 'active' where person_id = $1`, [invited]);
  const membership = await activeMembershipForClerkUser("clerk_inv");
  assert.equal(membership?.orgId, orgId);
  assert.deepEqual(membership?.roles, ["finance"]);
  await pool.query(`update org_people set status = 'suspended' where person_id = $1`, [invited]);
  assert.equal(await activeMembershipForClerkUser("clerk_inv"), null);
});

test("ensureClerkUserLinked: link-on-login flips an invited member without the webhook", async () => {
  const { orgId } = await activeOrgWithOwner();
  const invitee = await makePerson("late@t.test"); // invited: no clerk_user_id yet
  await addMembership(orgId, invitee, ["viewer"], "invited");
  // webhook never arrived; the fallback resolves the user from Clerk (injected) and links
  await ensureClerkUserLinked("clerk_late", async () => ({
    id: "clerk_late",
    email_addresses: [{ id: "e1", email_address: "late@t.test" }],
    primary_email_address_id: "e1",
    first_name: "Leo",
    last_name: "Lima",
  }));
  const m = await activeMembershipForClerkUser("clerk_late");
  assert.equal(m?.orgId, orgId);
  assert.deepEqual(m?.roles, ["viewer"]);
  // already linked -> no Clerk fetch (fetchUser throwing proves it isn't called)
  await ensureClerkUserLinked("clerk_late", async () => {
    throw new Error("must not fetch");
  });
  // a Clerk failure for an unknown user is swallowed (best-effort), not thrown
  await ensureClerkUserLinked("clerk_ghost", async () => {
    throw new Error("clerk down");
  });
});

test("inviteRedirectUrl deep-links to /sign-up with the invited email as a UI reference", () => {
  assert.equal(
    inviteRedirectUrl("https://app.example", "a+b@t.test"),
    "https://app.example/sign-up?invited=a%2Bb%40t.test",
  );
});

test("clerkSync: accepted invitation links clerk_user_id and flips invited -> active", async () => {
  const { orgId } = await activeOrgWithOwner();
  const invitee = await makePerson("accept@t.test"); // no clerk id yet (invite path shape)
  await addMembership(orgId, invitee, ["viewer"], "invited");
  await linkClerkUserFromEvent({
    type: "user.created",
    data: {
      id: "clerk_accept",
      email_addresses: [{ id: "e1", email_address: "accept@t.test" }],
      primary_email_address_id: "e1",
      first_name: "Ana",
      last_name: "Souza",
    },
  });
  const row = await pool.query<{ status: string }>(
    `select status from org_people where org_id = $1 and person_id = $2`,
    [orgId, invitee],
  );
  assert.equal(row.rows[0]!.status, "active");
  assert.equal((await activeMembershipForClerkUser("clerk_accept"))?.orgId, orgId);
});
