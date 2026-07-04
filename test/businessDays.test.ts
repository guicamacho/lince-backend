import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBusinessDay,
  addBusinessDays,
  deadlineAfter,
  businessDaysBetween,
  sydneyCivilDate,
} from "../src/modules/time/businessDays.js";
import { AU_HOLIDAYS } from "../src/modules/time/au-holidays.js";

test("Saturday is not a business day; the adjacent Friday is", () => {
  assert.equal(isBusinessDay("2026-01-03"), false); // Sat
  assert.equal(isBusinessDay("2026-01-02"), true); // Fri
});

test("Friday + 1 business day = Monday", () => {
  assert.equal(addBusinessDays("2026-01-09", 1), "2026-01-12"); // Fri -> Mon
  assert.equal(addBusinessDays("2026-01-12", -1), "2026-01-09"); // Mon -> Fri
});

test("New Year's Day is a holiday and gets skipped", () => {
  assert.equal(isBusinessDay("2026-01-01"), false); // Thu holiday
  assert.equal(addBusinessDays("2026-01-01", 1), "2026-01-02"); // start not counted, roll to Fri
  // Same date is a business day once the holiday set is empty.
  assert.equal(isBusinessDay("2026-01-01", new Set()), true);
});

test("spans a weekend plus two holidays (Christmas + Boxing Day observed)", () => {
  // Thu 24 Dec -> Fri 25 (Christmas) -> Sat/Sun -> Mon 28 (Boxing observed) -> Tue 29.
  assert.equal(addBusinessDays("2026-12-24", 1), "2026-12-29");
  // 2027: Christmas (Sat) + Boxing Day (Sun) push both substitutes to Mon/Tue.
  assert.equal(addBusinessDays("2027-12-24", 1), "2027-12-29");
});

test("businessDaysBetween counts (a, b] and inverts addBusinessDays", () => {
  assert.equal(businessDaysBetween("2026-01-02", "2026-01-09"), 5); // Mon..Fri
  assert.equal(businessDaysBetween("2026-01-09", "2026-01-02"), -5); // reversed
  const b = addBusinessDays("2026-01-09", 3);
  assert.equal(businessDaysBetween("2026-01-09", b), 3);
});

test("Anzac Day on a weekend grants no substitute weekday", () => {
  assert.equal(isBusinessDay("2027-04-25"), false); // Sun (Anzac Day)
  assert.equal(isBusinessDay("2027-04-26"), true); // Mon — no substitute holiday
});

test("deadlineAfter is business-day arithmetic on a civil date", () => {
  assert.equal(deadlineAfter("2026-01-02", 5), addBusinessDays("2026-01-02", 5));
});

test("Date inputs resolve to the Australia/Sydney civil date", () => {
  // 14:00 UTC on 1 Jan is already 2 Jan in Sydney (AEDT +11).
  const d = new Date("2026-01-01T14:00:00Z");
  assert.equal(sydneyCivilDate(d), "2026-01-02");
  assert.equal(isBusinessDay(d), true); // Fri 2 Jan, not the Thu holiday
});

test("AU_HOLIDAYS set is populated with the hardcoded national dates", () => {
  assert.ok(AU_HOLIDAYS.has("2026-12-25"));
  assert.ok(AU_HOLIDAYS.has("2027-06-14")); // King's Birthday
});
