import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { isOrgActive } from "../src/modules/access/requireActiveOrg.js";
import { resetDb, createOrg } from "./helpers.js";

beforeEach(resetDb);
after(() => pool.end());

test("isOrgActive is true ONLY when state = active", async () => {
  const pending = await createOrg("vendor_pending");
  const active = await createOrg("active");
  assert.equal(await isOrgActive(pending), false);
  assert.equal(await isOrgActive(active), true);
});

test("unknown org is not active", async () => {
  assert.equal(await isOrgActive("00000000-0000-0000-0000-000000000000"), false);
});
