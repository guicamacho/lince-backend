/**
 * Org lifecycle + the admission record (skeleton).
 *
 * MODELO A: admission is AVENIA'S decision (for BR). Lince's pre-screen is
 * completeness-only (no risk criteria). The "decision" recorded on an org is a RELAY
 * of Avenia's out-of-band verdict — see onboarding/admission.service.ts. There must be
 * NO code path where Lince makes its own BR admission decision.
 */
export type OrgState =
  | "pending_lince_approval" // completeness pre-screen pending
  | "kyb_in_progress"        // Didit verification underway
  | "vendor_pending"         // forwarded to Avenia, awaiting verdict (AdmissionPending)
  | "rfi_required"
  | "active"
  | "declined"
  | "rejected";

export type AdmissionState = "pending" | "approved" | "rejected";

/** Who is authorised to decide admission for a jurisdiction. BR = 'avenia' (locked). */
export type AdmissionAuthority = "avenia" | "lince" | "local_partner";

export interface AdmissionRecord {
  state: AdmissionState;
  authorityUsed: AdmissionAuthority | null;
  externalRef: string | null;   // Avenia's reference (BR)
  recordedBy: string | null;    // admin_users.id — the ops admin who RELAYED the verdict
  recordedAt: Date | null;
}

/** Allowed org-state transitions (skeleton; enforce in the service layer). */
export const ORG_TRANSITIONS: Record<OrgState, OrgState[]> = {
  pending_lince_approval: ["kyb_in_progress", "declined"],
  kyb_in_progress: ["vendor_pending", "rfi_required", "declined"],
  vendor_pending: ["active", "rejected", "rfi_required"],
  rfi_required: ["vendor_pending", "rejected", "kyb_in_progress"], // kyb_in_progress: RFI re-launches Didit (customer "Reiniciar verificação")
  active: [],
  declined: [],
  rejected: [],
};

/** True if `to` is a permitted next state from `from`. */
export function canTransition(from: OrgState, to: OrgState): boolean {
  return ORG_TRANSITIONS[from].includes(to);
}

/** Throws if the transition isn't permitted. Services call this before persisting a state change. */
export function assertTransition(from: OrgState, to: OrgState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal org state transition: ${from} -> ${to}`);
  }
}
