/**
 * Beneficiary rails — the canonical FIAT + CRYPTO catalog and the authoritative per-rail
 * validation. The customer app mirrors the labels/order for its form, but THIS is the wall:
 * every field a payout will use as a destination identifier is validated here before it's stored.
 *
 * Modelo A / travel rule: the payee identifier + tracing fields are retained by Lince and later
 * forwarded to Avenia. Validation is shape-level (formats, required-ness) — not checksum-perfect
 * (IBAN/address checksums are the rail's job at payout time); it exists to reject obviously-broken
 * input at capture, not to certify a destination. ponytail: tighten to full IBAN/EVM checksums if
 * capture-time rejection of typo'd destinations becomes worth the code.
 */
import { HttpError } from "../../http/error.js";

export type Rail = "pix" | "ach" | "fedwire" | "sepa" | "swift" | "crypto";
export const FIAT_RAILS: readonly Rail[] = ["pix", "ach", "fedwire", "sepa", "swift"];
const ALL_RAILS = new Set<Rail>([...FIAT_RAILS, "crypto"]);

const PIX_KEY_TYPES = new Set(["cpf", "cnpj", "email", "phone", "random"]);
const SWIFT_ASSETS = new Set(["USD", "EUR", "GBP"]);
const CRYPTO_ASSETS = new Set(["USDC", "USDT"]);

/** Crypto networks per stablecoin — labels MUST match the Depositar catalog (users match the
 *  source platform's network label). Kept here so backend + frontend can't drift. */
export const CRYPTO_NETWORKS: Record<string, string[]> = {
  USDT: ["TRON (TRC-20)", "Polygon", "Ethereum (ERC-20)"],
  USDC: ["Polygon", "Ethereum (ERC-20)", "Base"],
};

export interface ValidatedBeneficiary {
  label: string;
  rail: Rail;
  asset: string;
  network: string | null;
  destination: Record<string, string>;
  destHint: string;
  payeeLegalName: string;
  payeeCountry: string;
  purposeOfPayment: string;
  sourceOfFunds: string | null;
}

const str = (v: unknown) => String(v ?? "").trim();
function req(v: unknown, field: string, max = 200): string {
  const s = str(v);
  if (!s) throw new HttpError(`missing_${field}`, 400);
  if (s.length > max) throw new HttpError(`too_long_${field}`, 422);
  return s;
}
function country(v: unknown, field: string): string {
  const s = str(v).toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new HttpError(`invalid_${field}`, 422);
  return s;
}
const last4 = (s: string) => s.replace(/\s+/g, "").slice(-4);

/**
 * Validate + normalize a beneficiary submission for a given rail. Returns the record to persist,
 * or throws HttpError (neutral code). `destination` holds only the rail's identifier fields.
 */
export function validateBeneficiary(body: Record<string, unknown>): ValidatedBeneficiary {
  const label = req(body.label, "label", 120);
  const rail = str(body.rail) as Rail;
  if (!ALL_RAILS.has(rail)) throw new HttpError("invalid_rail", 400);
  const payeeLegalName = req(body.payeeLegalName, "payeeLegalName", 200);
  const purposeOfPayment = req(body.purposeOfPayment, "purposeOfPayment", 500);
  const sourceOfFunds = str(body.sourceOfFunds) || null;
  const d = (body.destination ?? {}) as Record<string, unknown>;

  let asset: string;
  let network: string | null = null;
  let destination: Record<string, string>;
  let primaryId: string;
  let payeeCountry: string;

  switch (rail) {
    case "pix": {
      asset = "BRL";
      payeeCountry = "BR";
      const pixKeyType = str(d.pixKeyType);
      if (!PIX_KEY_TYPES.has(pixKeyType)) throw new HttpError("invalid_pix_key_type", 422);
      const pixKey = req(d.pixKey, "pixKey", 140);
      destination = { pixKey, pixKeyType };
      primaryId = pixKey;
      break;
    }
    case "ach":
    case "fedwire": {
      asset = "USD";
      payeeCountry = "US";
      const routingNumber = req(d.routingNumber, "routingNumber", 9);
      if (!/^\d{9}$/.test(routingNumber)) throw new HttpError("invalid_routing_number", 422);
      const accountNumber = req(d.accountNumber, "accountNumber", 34);
      // Avenia's USD beneficiary registration additionally needs the bank's name and the
      // beneficiary's US address (bank-accounts/usd/, verified 2026-07-15). Captured here so
      // the payee is payable; pre-existing USD payees without them 422 at payout time.
      const bankName = req(d.bankName, "bankName", 200);
      const streetLine1 = req(d.streetLine1, "streetLine1", 200);
      const streetLine2 = str(d.streetLine2) || null;
      const city = req(d.city, "city", 100);
      const state = req(d.state, "state", 50);
      const postalCode = req(d.postalCode, "postalCode", 20);
      destination = {
        routingNumber, accountNumber, bankName, streetLine1, city, state, postalCode,
        ...(streetLine2 ? { streetLine2 } : {}),
      };
      primaryId = accountNumber;
      break;
    }
    case "sepa": {
      asset = "EUR";
      // Normalize (strip grouping spaces) BEFORE the length/format check — IBANs are entered in
      // 4-char groups, so a spaced long IBAN (e.g. Malta, 31 chars) exceeds a raw 34 cap.
      const iban = str(d.iban).replace(/\s+/g, "").toUpperCase();
      if (!iban) throw new HttpError("missing_iban", 400);
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new HttpError("invalid_iban", 422);
      const bic = req(d.bic, "bic", 11).toUpperCase();
      if (!/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) throw new HttpError("invalid_bic", 422);
      destination = { iban, bic };
      primaryId = iban;
      payeeCountry = iban.slice(0, 2); // country of the account per IBAN prefix
      break;
    }
    case "swift": {
      asset = str(body.asset).toUpperCase();
      if (!SWIFT_ASSETS.has(asset)) throw new HttpError("invalid_swift_asset", 422);
      const swiftBic = req(d.swiftBic, "swiftBic", 11).toUpperCase();
      if (!/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swiftBic)) throw new HttpError("invalid_swift_bic", 422);
      const account = (str(d.iban) || str(d.accountNumber)).replace(/\s+/g, "");
      if (!account) throw new HttpError("missing_account", 400);
      if (account.length > 34) throw new HttpError("too_long_account", 422); // cap like the other identifiers
      const bankName = req(d.bankName, "bankName", 200);
      const bankCountry = country(d.bankCountry, "bankCountry");
      payeeCountry = country(body.payeeCountry, "payeeCountry");
      destination = { swiftBic, account, bankName, bankCountry };
      primaryId = account;
      break;
    }
    case "crypto": {
      asset = str(body.asset).toUpperCase();
      if (!CRYPTO_ASSETS.has(asset)) throw new HttpError("invalid_crypto_asset", 422);
      network = str(body.network);
      if (!CRYPTO_NETWORKS[asset]!.includes(network)) throw new HttpError("invalid_network", 422);
      const walletAddress = req(d.walletAddress, "walletAddress", 120);
      const memoTag = str(d.memoTag);
      if (memoTag.length > 120) throw new HttpError("too_long_memoTag", 422);
      // Light per-family shape check — EVM chains are 0x+40 hex; TRON starts with T (base58, 34).
      const isEvm = /Polygon|Ethereum|Base/.test(network);
      if (isEvm && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) throw new HttpError("invalid_wallet_address", 422);
      if (/TRON/.test(network) && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress)) {
        throw new HttpError("invalid_wallet_address", 422);
      }
      payeeCountry = country(body.payeeCountry, "payeeCountry");
      destination = memoTag ? { walletAddress, memoTag } : { walletAddress };
      primaryId = walletAddress;
      break;
    }
    default:
      throw new HttpError("invalid_rail", 400);
  }

  return {
    label,
    rail,
    asset,
    network,
    destination,
    destHint: last4(primaryId),
    payeeLegalName,
    payeeCountry,
    purposeOfPayment,
    sourceOfFunds,
  };
}
