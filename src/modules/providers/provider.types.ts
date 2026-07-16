/** Provider interfaces shared across the Avenia/Didit integrations. */

// Observed live 2026-07-07 + integration guide: ON-HOLD sits between PROCESSING and PAID;
// CANCELED comes from PATCH /tickets/{id}/cancel (UNPAID only). Wire format uses hyphens
// (PARTIAL-FAILED, ON-HOLD) — normalize via ticketState.normalizeTicketStatus.
export type TicketState = "UNPAID" | "PROCESSING" | "ON_HOLD" | "PAID" | "FAILED" | "PARTIAL_FAILED" | "CANCELED";

/** KYC/KYB capture provider (Didit). MockKybProvider is the live implementation until Didit lands. */
export interface KybProvider {
  launchVerification(input: { orgId: string }): Promise<{ diditSessionId: string; hostedUrl: string }>;
}
