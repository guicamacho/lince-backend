/**
 * Versioned consent-document set the customer accepts at signup (PRD-02 AC-17 /
 * PRD-01 §13.2b). The `consent.accepted` audit_log row (written once per org in
 * bootstrap.ts) records who/when/which-version-of-each.
 *
 * ponytail: a code constant, not a `documents` table — versioned artifacts by id;
 * a table is unjustified until the wording is CMS-managed.
 */
export const CONSENT_VERSIONS = {
  avenia_terms: "v1",
  lince_channel_terms: "v1",
  lgpd_consent: "v1",
} as const;

export type ConsentVersions = { [K in keyof typeof CONSENT_VERSIONS]: string };
