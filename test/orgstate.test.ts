import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition } from "../src/modules/identity/org.state.js";

test("permits legal transitions", () => {
  assert.ok(canTransition("vendor_pending", "active"));
  assert.ok(canTransition("pending_lince_approval", "kyb_in_progress"));
  assert.ok(canTransition("rfi_required", "vendor_pending"));
});

test("rejects illegal transitions", () => {
  assert.equal(canTransition("active", "rejected"), false); // active is terminal
  assert.equal(canTransition("vendor_pending", "declined"), false);
  assert.throws(() => assertTransition("active", "pending_lince_approval"));
});
