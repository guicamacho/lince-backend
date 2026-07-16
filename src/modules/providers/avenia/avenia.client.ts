/**
 * Avenia client — live money rails: PIX deposit, internal swap (Convert), PIX payout.
 *
 * Service auth = API key + RSA request signing (PKCS#1 v1.5, SHA-256) over
 * timestamp + method + the FULL path+query + body, via the shared signing helper.
 * Every call carries ?subAccountId= except createSubAccount (master-scoped).
 */
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

/** Payout rails (PRD-11): held balance -> an external destination. Body shapes from
 *  integration-guide.avenia.io (Operations/quotesAndTickets + Beneficiaries-Bank-Accounts,
 *  verified 2026-07-15): BRL out via PIX (from BRLA), USD out via ACH/WIRE (from USDT/USDC),
 *  stablecoins out to external wallets (wallet inline in the ticket, no registration).
 *  EUR/SEPA (from EURC only) is deferred until customers can hold EURC. */
export interface UsdBeneficiaryBody {
  alias: string;
  bankAccountNumber: string;
  bankRoutingNumber: string; // ABA routing number
  bankBeneficiaryName: string;
  bankName: string;
  beneficiaryAddress: {
    streetLine1: string;
    streetLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string; // e.g. "USA"
  };
}
export interface PayoutRail {
  /** Register a BRL beneficiary bank account (PIX key) under a subaccount; returns Avenia's id. */
  createBrlBeneficiary(input: { subAccountId: string; alias: string; pixKey: string }): Promise<{ id: string }>;
  /** Register a USD beneficiary bank account (routing + account + address); returns Avenia's id. */
  createUsdBeneficiary(input: { subAccountId: string } & UsdBeneficiaryBody): Promise<{ id: string }>;
  createPixPayout(input: {
    subAccountId: string;
    inputCurrency: string; // held balance being paid out (BRLA today)
    inputAmount: string;
    beneficiaryBrlBankAccountId: string; // Avenia-side beneficiary id (createBrlBeneficiary)
    externalId?: string;
  }): Promise<AveniaSwapResult>;
  /** USD payout over ACH or WIRE, funded from a held stablecoin (USDT/USDC). */
  createUsdPayout(input: {
    subAccountId: string;
    inputCurrency: string; // USDT | USDC
    inputAmount: string;
    method: "ACH" | "WIRE";
    beneficiaryUsdBankAccountId: string; // Avenia-side beneficiary id (createUsdBeneficiary)
    externalId?: string;
  }): Promise<AveniaSwapResult>;
  /** Stablecoin send to an external wallet — the address rides inline, no registration. */
  createCryptoPayout(input: {
    subAccountId: string;
    currency: string; // USDT | USDC (input == output)
    inputAmount: string;
    chain: string; // Avenia chain enum: TRON | POLYGON | ETHEREUM | BASE | ...
    walletAddress: string;
    walletMemo?: string;
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

/** Nil-UUID beneficiaryWalletId = "credit this subaccount's own wallet". */
const OWN_WALLET = { beneficiaryWalletId: "00000000-0000-0000-0000-000000000000" };

export class AveniaClient implements SubAccountCreator, AccountInfoReader, DepositRail, SwapRail, PayoutRail, TicketReader {
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
    const { ticket, quote } = await this.quoteAndTicket({
      subAccountId: input.subAccountId,
      label: "deposit",
      quote: {
        inputCurrency: "BRL",
        inputPaymentMethod: "PIX",
        outputCurrency: "BRLA",
        outputPaymentMethod: "INTERNAL",
        inputAmount: input.amountBrl,
      },
      ticketOutput: { ticketBlockchainOutput: OWN_WALLET },
      externalId: input.externalId,
    });
    if (!ticket.brCode) throw new Error("avenia deposit ticket: missing brCode");
    return { ticketId: ticket.id, brCode: ticket.brCode, expiration: ticket.expiration ?? "", quote };
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

  /**
   * The one quote -> ticket primitive every money rail rides: GET fixed-rate (quoteToken lives
   * ~15s) then POST /v2/account/tickets/ (TRAILING SLASH — part of the signed URI) with the
   * rail's output body. externalId = our idem_key for vendor-side idempotency + orphan
   * recovery. Throws on any non-2xx; a ticket may auto-execute the instant it is POSTed, so
   * money-out callers must never mark 'failed' on a lost response (see convert.ts).
   */
  private async quoteAndTicket(input: {
    subAccountId: string;
    label: string; // error-message prefix: deposit | swap | payout
    quote: {
      inputCurrency: string;
      inputPaymentMethod: string;
      outputCurrency: string;
      outputPaymentMethod: string;
      inputAmount: string;
    };
    ticketOutput: Record<string, unknown>;
    externalId?: string;
  }): Promise<{ ticket: { id: string; brCode?: string; expiration?: string }; quote: AveniaSwapResult["quote"] }> {
    const q = new URLSearchParams({
      ...input.quote,
      inputThirdParty: "false",
      outputThirdParty: "false",
      blockchainSendMethod: "PERMIT", // required on blockchain-settled pairs (400 without it)
      subAccountId: input.subAccountId,
    });
    const quoteUri = `/v2/account/quote/fixed-rate?${q}`;
    const quoteRes = await fetch(`${this.config.baseUrl}${quoteUri}`, { headers: this.signedHeaders("GET", quoteUri) });
    if (!quoteRes.ok) throw new Error(`avenia ${input.label} quote ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`);
    const quote = (await quoteRes.json()) as AveniaSwapResult["quote"] & { quoteToken?: string };
    if (!quote.quoteToken) throw new Error(`avenia ${input.label} quote: no quoteToken`);

    const ticketUri = `/v2/account/tickets/?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const body = JSON.stringify({
      quoteToken: quote.quoteToken,
      ...input.ticketOutput,
      ...(input.externalId ? { externalId: input.externalId } : {}),
    });
    const ticketRes = await fetch(`${this.config.baseUrl}${ticketUri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", ticketUri, body),
      body,
    });
    if (!ticketRes.ok) throw new Error(`avenia ${input.label} ticket ${ticketRes.status}: ${(await ticketRes.text()).slice(0, 200)}`);
    const ticket = (await ticketRes.json()) as { id?: string; brCode?: string; expiration?: string };
    if (!ticket.id) throw new Error(`avenia ${input.label} ticket: no id`);
    return {
      ticket: { id: ticket.id, brCode: ticket.brCode, expiration: ticket.expiration },
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
    const { ticket, quote } = await this.quoteAndTicket({
      subAccountId: input.subAccountId,
      label: "swap",
      quote: {
        inputCurrency: input.inputCurrency,
        inputPaymentMethod: "INTERNAL",
        outputCurrency: input.outputCurrency,
        outputPaymentMethod: "INTERNAL",
        inputAmount: input.inputAmount,
      },
      ticketOutput: { ticketBlockchainOutput: OWN_WALLET },
      externalId: input.externalId,
    });
    return { ticketId: ticket.id, quote };
  }

  /** Register a BRL PIX beneficiary bank account under the subaccount. NOTE the collection
   *  path carries a TRAILING SLASH (like /tickets/) — it is part of the signed URI. */
  async createBrlBeneficiary(input: { subAccountId: string; alias: string; pixKey: string }): Promise<{ id: string }> {
    const uri = `/v2/account/beneficiaries/bank-accounts/brl/?subAccountId=${encodeURIComponent(input.subAccountId)}`;
    const body = JSON.stringify({ alias: input.alias, pixKey: input.pixKey });
    const res = await fetch(`${this.config.baseUrl}${uri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", uri, body),
      body,
    });
    if (!res.ok) throw new Error(`avenia beneficiary create ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { id?: string };
    if (!out.id) throw new Error("avenia beneficiary create: no id");
    return { id: out.id };
  }

  /**
   * PIX payout: GET fixed-rate quote (held INTERNAL currency -> BRL PIX, PERMIT) -> POST ticket
   * with ticketBrlPixOutput bound to the Avenia beneficiary. externalId = our idem_key for
   * vendor-side idempotency + orphan recovery, exactly like createSwap. Throws on any non-2xx —
   * and a payout ticket, like a swap, auto-executes once POSTed (callers must never mark
   * 'failed' on a lost response; see convert.ts).
   */
  async createPixPayout(input: {
    subAccountId: string;
    inputCurrency: string;
    inputAmount: string;
    beneficiaryBrlBankAccountId: string;
    externalId?: string;
  }): Promise<AveniaSwapResult> {
    const { ticket, quote } = await this.quoteAndTicket({
      subAccountId: input.subAccountId,
      label: "payout",
      quote: {
        inputCurrency: input.inputCurrency,
        inputPaymentMethod: "INTERNAL",
        outputCurrency: "BRL",
        outputPaymentMethod: "PIX",
        inputAmount: input.inputAmount,
      },
      ticketOutput: { ticketBrlPixOutput: { beneficiaryBrlBankAccountId: input.beneficiaryBrlBankAccountId } },
      externalId: input.externalId,
    });
    return { ticketId: ticket.id, quote };
  }

  /** Register a USD beneficiary bank account. Same TRAILING-SLASH collection path rule as /brl/. */
  async createUsdBeneficiary(input: { subAccountId: string } & UsdBeneficiaryBody): Promise<{ id: string }> {
    const { subAccountId, ...bankBody } = input;
    const uri = `/v2/account/beneficiaries/bank-accounts/usd/?subAccountId=${encodeURIComponent(subAccountId)}`;
    const body = JSON.stringify(bankBody);
    const res = await fetch(`${this.config.baseUrl}${uri}`, {
      method: "POST",
      headers: this.signedHeaders("POST", uri, body),
      body,
    });
    if (!res.ok) throw new Error(`avenia usd beneficiary create ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { id?: string };
    if (!out.id) throw new Error("avenia usd beneficiary create: no id");
    return { id: out.id };
  }

  async createUsdPayout(input: {
    subAccountId: string;
    inputCurrency: string;
    inputAmount: string;
    method: "ACH" | "WIRE";
    beneficiaryUsdBankAccountId: string;
    externalId?: string;
  }): Promise<AveniaSwapResult> {
    const { ticket, quote } = await this.quoteAndTicket({
      subAccountId: input.subAccountId,
      label: "payout",
      quote: {
        inputCurrency: input.inputCurrency,
        inputPaymentMethod: "INTERNAL",
        outputCurrency: "USD",
        outputPaymentMethod: input.method,
        inputAmount: input.inputAmount,
      },
      // WIRE and ACH carry different output keys (integration guide, quotesAndTickets).
      ticketOutput: input.method === "WIRE"
        ? { ticketUsdWireOutput: { beneficiaryUsdBankAccountId: input.beneficiaryUsdBankAccountId } }
        : { ticketUsdOutput: { beneficiaryUsdBankAccountId: input.beneficiaryUsdBankAccountId } },
      externalId: input.externalId,
    });
    return { ticketId: ticket.id, quote };
  }

  async createCryptoPayout(input: {
    subAccountId: string;
    currency: string;
    inputAmount: string;
    chain: string;
    walletAddress: string;
    walletMemo?: string;
    externalId?: string;
  }): Promise<AveniaSwapResult> {
    const { ticket, quote } = await this.quoteAndTicket({
      subAccountId: input.subAccountId,
      label: "payout",
      quote: {
        inputCurrency: input.currency,
        inputPaymentMethod: "INTERNAL",
        outputCurrency: input.currency,
        outputPaymentMethod: input.chain,
        inputAmount: input.inputAmount,
      },
      ticketOutput: {
        ticketBlockchainOutput: {
          walletChain: input.chain,
          walletAddress: input.walletAddress,
          ...(input.walletMemo ? { walletMemo: input.walletMemo } : {}),
        },
      },
      externalId: input.externalId,
    });
    return { ticketId: ticket.id, quote };
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
