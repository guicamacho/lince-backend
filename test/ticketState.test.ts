/** Pure monotonic + idempotent ticket guard — the whole "no regression" rule lives here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketTransitionAllowed } from "../src/modules/webhooks/ticketState.js";

test("null current => apply (first event)", () => {
  assert.equal(ticketTransitionAllowed(null, "UNPAID"), "apply");
  assert.equal(ticketTransitionAllowed(null, "PAID"), "apply");
});

test("same state => ignore (idempotent replay)", () => {
  assert.equal(ticketTransitionAllowed("PROCESSING", "PROCESSING"), "ignore");
  assert.equal(ticketTransitionAllowed("PAID", "PAID"), "ignore");
});

test("forward => apply (incl. legal skip)", () => {
  assert.equal(ticketTransitionAllowed("UNPAID", "PROCESSING"), "apply");
  assert.equal(ticketTransitionAllowed("PROCESSING", "PAID"), "apply");
  assert.equal(ticketTransitionAllowed("UNPAID", "PAID"), "apply");
});

test("older / late event => ignore (monotonic, no regression)", () => {
  assert.equal(ticketTransitionAllowed("PROCESSING", "UNPAID"), "ignore");
  assert.equal(ticketTransitionAllowed("PAID", "PROCESSING"), "ignore"); // late PROCESSING after PAID
});

test("terminal never regresses to another terminal => ignore", () => {
  assert.equal(ticketTransitionAllowed("PAID", "FAILED"), "ignore");
  assert.equal(ticketTransitionAllowed("FAILED", "PAID"), "ignore");
  assert.equal(ticketTransitionAllowed("PARTIAL_FAILED", "PAID"), "ignore");
});

test("unknown incoming state => reject (trust boundary)", () => {
  assert.equal(ticketTransitionAllowed(null, "WAT"), "reject");
  assert.equal(ticketTransitionAllowed("PROCESSING", "bogus"), "reject");
});
