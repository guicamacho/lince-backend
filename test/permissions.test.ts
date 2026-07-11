/** PRD-03 §1 matrix + §5 KYB-tag inertness — the whole customer authz decision, no DB. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { can, accessRoles } from "../src/modules/access/permissions.js";

test("role matrix enforced exactly (PRD-03 §1)", () => {
  // viewer: read-only
  assert.equal(can(["viewer"], "view_transactions"), true);
  assert.equal(can(["viewer"], "manage_beneficiaries"), false);
  assert.equal(can(["viewer"], "initiate_payout"), false);
  assert.equal(can(["viewer"], "manage_team"), false);
  // finance: moves money, nothing else
  assert.equal(can(["finance"], "initiate_payout"), true);
  assert.equal(can(["finance"], "manage_beneficiaries"), true);
  assert.equal(can(["finance"], "manage_team"), false);
  assert.equal(can(["finance"], "enable_rails"), false);
  // admin: everything but transfer
  assert.equal(can(["admin"], "manage_team"), true);
  assert.equal(can(["admin"], "add_org"), true);
  assert.equal(can(["admin"], "transfer_ownership"), false);
  // owner: admin + transfer
  assert.equal(can(["owner"], "transfer_ownership"), true);
  assert.equal(can(["owner"], "manage_team"), true);
});

test("KYB tags are inert: alone they grant nothing; mixed they add nothing", () => {
  for (const tag of ["legal_rep", "ubo", "director"]) {
    assert.equal(can([tag], "view_dashboard"), false, tag);
    assert.equal(can([tag], "initiate_payout"), false, tag);
  }
  // the bootstrap owner shape: access comes from 'owner', not 'legal_rep'
  assert.equal(can(["owner", "legal_rep"], "transfer_ownership"), true);
  assert.deepEqual(accessRoles(["owner", "legal_rep"]), ["owner"]);
  assert.deepEqual(accessRoles(["ubo", "director"]), []);
});

test("roles are additive across the set", () => {
  assert.equal(can(["viewer", "finance"], "initiate_payout"), true);
  assert.equal(can(["viewer", "finance"], "manage_team"), false);
});
