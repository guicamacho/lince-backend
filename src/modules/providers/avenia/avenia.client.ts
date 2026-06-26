/**
 * Avenia client — the HARNESS is real, the money calls are STUBBED.
 *
 * Service auth = API key + RSA request signing (PKCS#1 v1.5, SHA-256) over the FULL
 * path + query string. Every call carries ?subAccountId=. The signing scaffold below is
 * implemented so the eventual calls only need their bodies + endpoints filled in.
 *
 * Money flows (quote -> ticket, deposit/swap/payout) are gated on the Avenia
 * Wallets/Operations API mapping (BUILD_BRIEF §6) and throw until then.
 */
import { createSign } from "node:crypto";
import type { Currency } from "../../../money/money.js";
import type { Quote, Ticket, RailProvider } from "../provider.types.js";
import type { AveniaConfig } from "./avenia.types.js";

export class AveniaClient implements RailProvider {
  constructor(private readonly config: AveniaConfig) {}

  /** Sign the full request path+query per Avenia's scheme (PKCS#1 v1.5, SHA-256, base64). */
  private sign(pathWithQuery: string): string {
    const signer = createSign("RSA-SHA256");
    signer.update(pathWithQuery);
    signer.end();
    return signer.sign(this.config.signingPrivateKeyPem, "base64");
  }

  /** Build headers for a signed request (shape; wire to fetch when endpoints are mapped). */
  private signedHeaders(pathWithQuery: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
      "X-Signature": this.sign(pathWithQuery),
    };
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
}
