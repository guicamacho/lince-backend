/**
 * AU national public holidays, 2026–2027, as civil-date strings (YYYY-MM-DD in
 * Australia/Sydney). Observed dates: when a holiday lands on a weekend the
 * substitute weekday is listed too (NSW / common-national rule). Anzac Day is
 * the known exception — most states grant NO substitute when it falls on a
 * weekend, so we don't add one here (WA does; feed its Monday via AU_HOLIDAYS if
 * you operate there).
 *
 * ponytail: hardcoded through 2027 only — this is the calibration knob. Extend
 * the literal each year, or feed extra/override dates through the AU_HOLIDAYS
 * env CSV (e.g. "2028-01-01,2028-01-26"). No holiday library, no annual API call.
 */
const NATIONAL_2026_2027: readonly string[] = [
  // 2026
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-26", // Australia Day (Mon)
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-04-25", // Anzac Day (Sat — no substitute)
  "2026-06-08", // King's Birthday (2nd Mon of June)
  "2026-12-25", // Christmas Day (Fri)
  "2026-12-26", // Boxing Day (Sat)
  "2026-12-28", // Boxing Day observed (Mon)
  // 2027
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-26", // Australia Day (Tue)
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-04-25", // Anzac Day (Sun — no substitute)
  "2027-06-14", // King's Birthday (2nd Mon of June)
  "2027-12-25", // Christmas Day (Sat)
  "2027-12-27", // Christmas Day observed (Mon)
  "2027-12-26", // Boxing Day (Sun)
  "2027-12-28", // Boxing Day observed (Tue)
];

/** Extra/override holidays from the AU_HOLIDAYS env CSV, read once at import. */
function envHolidays(): string[] {
  const csv = process.env.AU_HOLIDAYS;
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Union of the hardcoded national dates and any AU_HOLIDAYS env overrides. */
export const AU_HOLIDAYS: ReadonlySet<string> = new Set([
  ...NATIONAL_2026_2027,
  ...envHolidays(),
]);
