/**
 * Avenia client — the HARNESS is real, the money calls are STUBBED.
 *
 * Service auth = API key + RSA request signing (PKCS#1 v1.5, SHA-256) over
 * timestamp + method + the FULL path+query + body, via the shared signing helper.
 * Every call carries ?subAccountId=.
 *
 * Money flows (quote -> ticket, deposit/swap/payout) are gated on the Avenia
 * Wallets/Operations API mapping (BUILD_BRIEF §6) and throw until then.
 */
import type { Currency } from "../../../money/money.js";
import type { Quote, Ticket, RailProvider } from "../provider.types.js";
import type { AveniaConfig } from "./avenia.types.js";
import { aveniaSignedHeaders } from "./signing.js";
import { env } from "../../../config/env.js";

/** The one capability onboarding provisioning needs — lets tests inject a fake. */
export interface SubAccountCreator {
  createSubAccount(name: string): Promise<{ id: string }>;
}

/** Deposit-relevant slice of GET /v2/account/account-info. */
export interface AveniaAccountInfo {
  pixKey?: string;
  brCode?: string;
  wallets?: Array<{ walletAddress: string; chain: string }>;
}
export interface AccountInfoReader {
  getAccountInfo(subAccountId?: string): Promise<AveniaAccountInfo>;
}

/** Raw quote fields the deposit flow snapshots (amounts stay decimal STRINGS off the wire;
 *  the money module converts to bigint minor units at the edge). */
export interface AveniaDepositResult {
  ticketId: string;
  brCode: string;
  expiration: string;
  quote: {
    inputCurrency: string;
    inputAmount: string;
    outputCurrency: string;
    outputAmount: string;
    basePrice: string;
    pairName: string;
    appliedFees: Array<{ type: string; amount: string; currency: string; rebatable: boolean; description?: string }>;
  };
}

export interface DepositRail {
  createPixDeposit(input: { subAccountId: string; amountBrl: string }): Promise<AveniaDepositResult>;
}

export interface TicketReader {
  getTicket(input: { subAccountId: string; ticketId: string }): Promise<{ id: string; status: string }>;
}

export class AveniaClient implements RailProvider, SubAccountCreator, AccountInfoReader, DepositRail, TicketReader {
  constructor(private readonly config: AveniaConfig) {}

  /** One ticket's current status — the reconciler's poll (subAccountId must match the
   *  quote's scoping or Avenia 404s). */
  async getTicket(input: { subAccountId: string; ticketId: string }): Promise<{ id: string; status: string }> {
    const requestUri = `/v2/account/tickets/${encodeURIComponent(input.ticketId)}?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const res = await fetch(`${this.config.baseUrl}${requestUri}`, { headers: this.signedHeaders("GET", requestUri) });
    if (!res.ok) throw new Error(`avenia ticket get ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { ticket?: { id?: string; status?: string } };
    if (!out.ticket?.id || !out.ticket.status) throw new Error("avenia ticket get: missing id/status");
    return { id: out.ticket.id, status: out.ticket.status };
  }

  /** PIX-in deposit for a subaccount: quote + ticket inside the 15s quoteToken window.
   *  Returns the brCode the customer pays; nothing moves until it's paid. The nil-UUID
   *  beneficiaryWalletId means "this subaccount" — resolved from subAccountId at quote time. */
  async createPixDeposit(input: { subAccountId: string; amountBrl: string }): Promise<AveniaDepositResult> {
    const q = new URLSearchParams({
      inputCurrency: "BRL",
      inputPaymentMethod: "PIX",
      outputCurrency: "BRLA",
      outputPaymentMethod: "INTERNAL",
      inputAmount: input.amountBrl,
      inputThirdParty: "false",
      outputThirdParty: "false",
      blockchainSendMethod: "PERMIT",
      subAccountId: input.subAccountId,
    });
    const quoteUri = `/v2/account/quote/fixed-rate?${q}`;
    const quoteRes = await fetch(`${this.config.baseUrl}${quoteUri}`, { headers: this.signedHeaders("GET", quoteUri) });
    if (!quoteRes.ok) throw new Error(`avenia quote ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`);
    const quote = (await quoteRes.json()) as AveniaDepositResult["quote"] & { quoteToken?: string };
    if (!quote.quoteToken) throw new Error("avenia quote: no quoteToken");

    const ticketUri = `/v2/account/tickets/?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const body = JSON.stringify({
      quoteToken: quote.quoteToken,
      ticketBlockchainOutput: { beneficiaryWalletId: "00000000-0000-0000-0000-000000000000" },
    });
    const ticketRes = await fetch(`${this.config.baseUrl}${ticketUri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", ticketUri, body),
      body,
    });
    if (!ticketRes.ok) throw new Error(`avenia ticket ${ticketRes.status}: ${(await ticketRes.text()).slice(0, 200)}`);
    const ticket = (await ticketRes.json()) as { id?: string; brCode?: string; expiration?: string };
    if (!ticket.id || !ticket.brCode) throw new Error("avenia ticket: missing id/brCode");
    return {
      ticketId: ticket.id,
      brCode: ticket.brCode,
      expiration: ticket.expiration ?? "",
      quote: {
        inputCurrency: quote.inputCurrency,
        inputAmount: quote.inputAmount,
        outputCurrency: quote.outputCurrency,
        outputAmount: quote.outputAmount,
        basePrice: quote.basePrice,
        pairName: quote.pairName,
        appliedFees: quote.appliedFees ?? [],
      },
    };
  }

  /** Account info (wallets + PIX key/brCode). Scoped to a subaccount when given,
   *  else the MAIN account. Read-only. */
  async getAccountInfo(subAccountId?: string): Promise<AveniaAccountInfo> {
    const requestUri = `/v2/account/account-info${subAccountId ? `?subAccountId=${encodeURIComponent(subAccountId)}` : ""}`;
    const res = await fetch(`${this.config.baseUrl}${requestUri}`, {
      headers: this.signedHeaders("GET", requestUri),
    });
    if (!res.ok) throw new Error(`avenia account-info ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as AveniaAccountInfo;
  }

  /** COMPANY subaccount on the MAIN account (Connectivity §1/§3) — one per customer org.
   *  Master-scoped: no subAccountId param. PERMANENT on Avenia (no delete). */
  async createSubAccount(name: string): Promise<{ id: string }> {
    const requestUri = "/v2/account/sub-accounts";
    const body = JSON.stringify({ accountType: "COMPANY", name });
    const res = await fetch(`${this.config.baseUrl}${requestUri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", requestUri, body),
      body,
    });
    if (!res.ok) throw new Error(`avenia sub-accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { id?: string };
    if (!out.id) throw new Error("avenia sub-accounts: no id in response");
    return { id: out.id };
  }

  /** Build the signed headers for a request (X-API-Key/X-API-Timestamp/X-API-Signature). */
  private signedHeaders(method: string, requestUri: string, body?: string): Record<string, string> {
    return aveniaSignedHeaders(this.config.apiKey, {
      method,
      requestUri,
      body,
      privateKeyPem: this.config.signingPrivateKeyPem,
    });
  }

  async getFixedRateQuote(_input: {
    subAccountId: string;
    sourceCurrency: Currency;
    destCurrency: Currency;
    sourceAmount: bigint;
  }): Promise<Quote> {
    // GET /v2/account/quote/fixed-rate?subAccountId=…  (quoteToken ~15s, appliedFees[] each rebatable)
    throw new Error("STUB: Avenia quote gated on Wallets/Operations API mapping (BUILD_BRIEF §6)");
  }

  async createTicket(_input: { subAccountId: string; quoteToken: string }): Promise<Ticket> {
    // POST /v2/account/tickets?subAccountId=…  (lifecycle UNPAID->PROCESSING->PAID->FAILED)
    throw new Error("STUB: Avenia ticket gated on Wallets/Operations API mapping (BUILD_BRIEF §6)");
  }

  async listTickets(_input: { subAccountId: string }): Promise<Ticket[]> {
    // GET /v2/account/tickets?subAccountId=…  (webhook delivery-gap poll — B3/gapPoll)
    throw new Error("STUB: Avenia listTickets gated on Wallets/Operations API mapping (BUILD_BRIEF §6)");
  }
}

// Composition point: the env-configured client, or null when keys are absent
// (tests / keyless dev — callers must treat null as "Avenia disabled").
let fromEnv: AveniaClient | null | undefined;
export function aveniaFromEnv(): AveniaClient | null {
  if (fromEnv === undefined) {
    const { baseUrl, apiKey, signingPrivateKeyPem } = env.avenia;
    fromEnv = apiKey && signingPrivateKeyPem ? new AveniaClient({ baseUrl, apiKey, signingPrivateKeyPem }) : null;
  }
  return fromEnv;
}
