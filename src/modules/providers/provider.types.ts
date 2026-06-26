/** Provider interfaces. Implementations are STUBBED until vendor confirmations (BUILD_BRIEF §3/§6). */
import type { Currency } from "../../money/money.js";

/** A fixed-rate quote token (Avenia: ~15s TTL) with itemized fees, each possibly rebatable. */
export interface Quote {
  quoteToken: string;
  expiresAt: Date;
  sourceCurrency: Currency;
  sourceAmount: bigint;
  destCurrency: Currency;
  destAmount: bigint;
  appliedFees: Array<{ label: string; amount: bigint; currency: Currency; rebatable: boolean }>;
}

export type TicketState = "UNPAID" | "PROCESSING" | "PAID" | "FAILED" | "PARTIAL_FAILED";

export interface Ticket {
  ticketId: string;
  state: TicketState;
}

/** Rail provider (Avenia in P1): quote -> ticket. Money flows are STUBBED. */
export interface RailProvider {
  getFixedRateQuote(input: {
    subAccountId: string;
    sourceCurrency: Currency;
    destCurrency: Currency;
    sourceAmount: bigint;
  }): Promise<Quote>;
  createTicket(input: { subAccountId: string; quoteToken: string }): Promise<Ticket>;
}

/** KYC/KYB capture provider (Didit). Capture/forward is STUBBED. */
export interface KybProvider {
  launchVerification(input: { orgId: string }): Promise<{ diditSessionId: string; hostedUrl: string }>;
}
