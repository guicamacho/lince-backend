/** Template registry — pure: tipping-off gate, versioning, render. No DB. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, isSendable, renderTemplate, type Template } from "../src/modules/notifications/templates.js";

const base: Omit<Template, "recipientClass" | "tipping_off_reviewed"> = {
  version: 1,
  locale: "pt-BR",
  subject: "s",
  body: "b",
};

test("unreviewed customer template is refused by the gate", () => {
  assert.equal(isSendable({ ...base, recipientClass: "customer", tipping_off_reviewed: false }), false);
});

test("unreviewed payee template is refused by the gate", () => {
  assert.equal(isSendable({ ...base, recipientClass: "payee", tipping_off_reviewed: false }), false);
});

test("admin template always sends (gate applies to customer/payee only)", () => {
  assert.equal(isSendable({ ...base, recipientClass: "admin", tipping_off_reviewed: false }), true);
});

test("reviewed customer template is sendable", () => {
  assert.equal(isSendable({ ...base, recipientClass: "customer", tipping_off_reviewed: true }), true);
});

test("every registered template is versioned and pt-BR", () => {
  for (const [id, t] of Object.entries(TEMPLATES)) {
    assert.ok(t.version >= 1, `${id} must be versioned`);
    assert.equal(t.locale, "pt-BR", `${id} locale`);
  }
});

test("live customer templates are review-cleared (never refused at send)", () => {
  for (const id of ["activation_approved", "application_rejected", "beneficiary_added"] as const) {
    assert.equal(isSendable(TEMPLATES[id]), true, id);
  }
});

test("a deferred, unreviewed template stays refused until copy is reviewed", () => {
  assert.equal(isSendable(TEMPLATES.returned_to_complete), false);
});

test("renderTemplate fills {{var}} from payload; missing var renders empty", () => {
  const r = renderTemplate("beneficiary_added", { label: "Supplier AU" });
  assert.match(r.body, /Supplier AU/);
  const blank = renderTemplate("beneficiary_added", {});
  assert.doesNotMatch(blank.body, /\{\{/);
});
