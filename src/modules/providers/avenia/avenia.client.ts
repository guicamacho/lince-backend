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
  createPixDeposit(input: { subAccountId: string; amountBrl: string; externalId?: string }): Promise<AveniaDepositResult>;
}

/** Internal currency swap (Convert, PRD-10). Same quote->ticket primitive as a deposit, output
 *  INTERNAL so the result stays in the subaccount wallet. Confirmed live 2026-07-12 (settles PAID). */
export interface AveniaSwapResult {
  ticketId: string;
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
export interface SwapRail {
  createSwap(input: {
    subAccountId: string;
    inputCurrency: string;
    outputCurrency: string;
    inputAmount: string;
    externalId?: string;
  }): Promise<AveniaSwapResult>;
}

export interface TicketView {
  id: string;
  status: string;
  outputAmount?: string; // the credited amount (decimal string) from the ticket's quote
}
export interface TicketReader {
  getTicket(input: { subAccountId: string; ticketId: string }): Promise<TicketView>;
  /** Recover a ticket by the externalId we set at creation (our idem_key) — used to heal a
   *  deposit row that owns a live ticket but never persisted its id (crash mid-create). Null if
   *  none. */
  findTicketByExternalId(input: { subAccountId: string; externalId: string }): Promise<TicketView | null>;
}

export class AveniaClient implements RailProvider, SubAccountCreator, AccountInfoReader, DepositRail, SwapRail, TicketReader {
  constructor(private readonly config: AveniaConfig) {}

  /** One ticket's current status — the reconciler's poll (subAccountId must match the
   *  quote's scoping or Avenia 404s). */
  async getTicket(input: { subAccountId: string; ticketId: string }): Promise<TicketView> {
    const requestUri = `/v2/account/tickets/${encodeURIComponent(input.ticketId)}?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const res = await fetch(`${this.config.baseUrl}${requestUri}`, { headers: this.signedHeaders("GET", requestUri) });
    if (!res.ok) throw new Error(`avenia ticket get ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { ticket?: { id?: string; status?: string; quote?: { outputAmount?: string } } };
    if (!out.ticket?.id || !out.ticket.status) throw new Error("avenia ticket get: missing id/status");
    return { id: out.ticket.id, status: out.ticket.status, outputAmount: out.ticket.quote?.outputAmount };
  }

  /** List the subaccount's tickets filtered by externalId (our idem_key), returning the first. */
  async findTicketByExternalId(input: { subAccountId: string; externalId: string }): Promise<TicketView | null> {
    const requestUri = `/v2/account/tickets/?subAccountId=${encodeURIComponent(input.subAccountId)}&externalId=${encodeURIComponent(input.externalId)}`;
    const res = await fetch(`${this.config.baseUrl}${requestUri}`, { headers: this.signedHeaders("GET", requestUri) });
    if (!res.ok) throw new Error(`avenia ticket list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { tickets?: Array<{ id?: string; status?: string; quote?: { outputAmount?: string } }> };
    const t = out.tickets?.[0];
    return t?.id && t.status ? { id: t.id, status: t.status, outputAmount: t.quote?.outputAmount } : null;
  }

  /** PIX-in deposit for a subaccount: quote + ticket inside the 15s quoteToken window.
   *  Returns the brCode the customer pays; nothing moves until it's paid. The nil-UUID
   *  beneficiaryWalletId means "this subaccount" — resolved from subAccountId at quote time. */
  async createPixDeposit(input: { subAccountId: string; amountBrl: string; externalId?: string }): Promise<AveniaDepositResult> {
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
      // Vendor idempotency: our idem_key. A retry with the same key won't create a duplicate
      // ticket, and lets the reconciler recover a ticket whose id we failed to persist.
      ...(input.externalId ? { externalId: input.externalId } : {}),
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

  /**
   * DISPLAY-ONLY rate quote for a stablecoin pair (BRLA<>USDT for BRL/USD, BRLA>EURC for BRL/EUR).
   * A GET quote — no ticket — so it does NOT need the gated execution mapping. Returns the pair's
   * BARE `basePrice` (BRL per foreign unit, fee-free — the "sem tarifas" reference; the fee-laden
   * effective rate lives in inputAmount/outputAmount instead). Never crashes a dashboard read: any
   * error/odd shape -> null and the caller falls back to mid-market.
   *
   * Verified against the sandbox 2026-07-12: these are blockchain-settled pairs, so the quote
   * REQUIRES blockchainSendMethod (400 "…:blockchainSendMethod is invalid" without it); fiat EUR
   * output is rejected outright, which is why the EUR leg quotes EURC (the euro-coin), mirroring
   * USDT for USD.
   */
  async quoteRate(input: {
    subAccountId: string;
    inputCurrency: string;
    outputCurrency: string;
    inputAmount?: string;
  }): Promise<{ price: number } | null> {
    try {
      const q = new URLSearchParams({
        inputCurrency: input.inputCurrency,
        inputPaymentMethod: "INTERNAL",
        outputCurrency: input.outputCurrency,
        outputPaymentMethod: "INTERNAL",
        inputAmount: input.inputAmount ?? "1000",
        inputThirdParty: "false",
        outputThirdParty: "false",
        blockchainSendMethod: "PERMIT",
        subAccountId: input.subAccountId,
      });
      const uri = `/v2/account/quote/fixed-rate?${q}`;
      const res = await fetch(`${this.config.baseUrl}${uri}`, { headers: this.signedHeaders("GET", uri) });
      if (!res.ok) return null;
      const j = (await res.json()) as { basePrice?: string };
      const price = Number(j.basePrice);
      return Number.isFinite(price) && price > 0 ? { price } : null;
    } catch {
      return null;
    }
  }

  /**
   * Internal currency swap (Convert). Real execution: GET fixed-rate quote (INTERNAL/INTERNAL,
   * blockchainSendMethod=PERMIT for the crypto legs) -> POST ticket with the deposit-style body
   * (INTERNAL output stays in the subaccount wallet). externalId = our idem_key for vendor-side
   * idempotency + orphan recovery, exactly like createPixDeposit. Throws on any non-2xx.
   */
  async createSwap(input: {
    subAccountId: string;
    inputCurrency: string;
    outputCurrency: string;
    inputAmount: string;
    externalId?: string;
  }): Promise<AveniaSwapResult> {
    const q = new URLSearchParams({
      inputCurrency: input.inputCurrency,
      inputPaymentMethod: "INTERNAL",
      outputCurrency: input.outputCurrency,
      outputPaymentMethod: "INTERNAL",
      inputAmount: input.inputAmount,
      inputThirdParty: "false",
      outputThirdParty: "false",
      blockchainSendMethod: "PERMIT",
      subAccountId: input.subAccountId,
    });
    const quoteUri = `/v2/account/quote/fixed-rate?${q}`;
    const quoteRes = await fetch(`${this.config.baseUrl}${quoteUri}`, { headers: this.signedHeaders("GET", quoteUri) });
    if (!quoteRes.ok) throw new Error(`avenia swap quote ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`);
    const quote = (await quoteRes.json()) as AveniaSwapResult["quote"] & { quoteToken?: string };
    if (!quote.quoteToken) throw new Error("avenia swap quote: no quoteToken");

    const ticketUri = `/v2/account/tickets/?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const body = JSON.stringify({
      quoteToken: quote.quoteToken,
      ticketBlockchainOutput: { beneficiaryWalletId: "00000000-0000-0000-0000-000000000000" },
      ...(input.externalId ? { externalId: input.externalId } : {}),
    });
    const ticketRes = await fetch(`${this.config.baseUrl}${ticketUri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", ticketUri, body),
      body,
    });
    if (!ticketRes.ok) throw new Error(`avenia swap ticket ${ticketRes.status}: ${(await ticketRes.text()).slice(0, 200)}`);
    const ticket = (await ticketRes.json()) as { id?: string };
    if (!ticket.id) throw new Error("avenia swap ticket: no id");
    return {
      ticketId: ticket.id,
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
