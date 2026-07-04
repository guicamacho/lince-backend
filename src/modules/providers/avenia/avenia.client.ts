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

export class AveniaClient implements RailProvider {
  constructor(private readonly config: AveniaConfig) {}

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
