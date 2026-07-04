/**
 * Business-day math for AU (Australia/Sydney) SLA/deadline windows — RFI clocks,
 * dormancy timers, and the like. Weekends + AU national public holidays skip.
 *
 * Inputs accept a Date (converted to its Sydney civil date) or a 'YYYY-MM-DD'
 * civil-date string. addBusinessDays/deadlineAfter return a 'YYYY-MM-DD' civil
 * string (a deadline is a calendar date, not an instant — and it feeds straight
 * back into these functions). All weekday math is done at UTC midnight of the
 * civil date, which is DST-free, so the day-of-week is always correct.
 *
 * ponytail: naive O(n) one-day-at-a-time step — n is single/low-double digits
 * for every real caller. If someone ever needs +100000 business days, precompute
 * a weekday/holiday prefix-sum; until then the loop is the whole thing.
 */
import { AU_HOLIDAYS } from "./au-holidays.js";

const civilFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A Date -> its 'YYYY-MM-DD' civil date in Australia/Sydney. */
export function sydneyCivilDate(date: Date): string {
  return civilFmt.format(date); // en-CA => YYYY-MM-DD
}

function toCivil(date: Date | string): string {
  return typeof date === "string" ? date : sydneyCivilDate(date);
}

/** Parse 'YYYY-MM-DD' to a UTC-midnight Date (pure calendar date, DST-free). */
function utcMidnight(civil: string): Date {
  const d = new Date(`${civil}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid civil date: ${civil}`);
  return d;
}

/** UTC-midnight Date -> 'YYYY-MM-DD'. */
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isBusinessUtc(d: Date, holidays: ReadonlySet<string>): boolean {
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  return dow !== 0 && dow !== 6 && !holidays.has(fromUtc(d));
}

export function isBusinessDay(
  date: Date | string,
  holidays: ReadonlySet<string> = AU_HOLIDAYS,
): boolean {
  return isBusinessUtc(utcMidnight(toCivil(date)), holidays);
}

/**
 * `n` business days from `date` (positive = forward, negative = backward). The
 * start date is never counted and the result is always a business day. Returns
 * the resulting 'YYYY-MM-DD' civil date.
 */
export function addBusinessDays(
  date: Date | string,
  n: number,
  holidays: ReadonlySet<string> = AU_HOLIDAYS,
): string {
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  const d = utcMidnight(toCivil(date));
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (isBusinessUtc(d, holidays)) remaining--;
  }
  return fromUtc(d);
}

/** The deadline `n` business days after `from` (n >= 0). Intent-named wrapper. */
export function deadlineAfter(
  from: Date | string,
  n: number,
  holidays: ReadonlySet<string> = AU_HOLIDAYS,
): string {
  return addBusinessDays(from, n, holidays);
}

/**
 * Business days in the half-open range (a, b]: excludes `a`, includes `b`.
 * Inverse of addBusinessDays — businessDaysBetween(a, addBusinessDays(a, n))
 * === n for n >= 0. Negative when `b` precedes `a`.
 */
export function businessDaysBetween(
  a: Date | string,
  b: Date | string,
  holidays: ReadonlySet<string> = AU_HOLIDAYS,
): number {
  const cursor = utcMidnight(toCivil(a));
  const end = utcMidnight(toCivil(b));
  const step = end.getTime() < cursor.getTime() ? -1 : 1;
  let count = 0;
  while (cursor.getTime() !== end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    if (isBusinessUtc(cursor, holidays)) count++;
  }
  return step < 0 ? -count : count;
}
