/**
 * Avenia sandbox test CLI — exercises the API with the Lince MAIN (master) account.
 *
 * The master account is already KYB'd/approved on Avenia's side; calls WITHOUT
 * ?subAccountId= resolve to it (docs: Sandbox Usecases / receiveMockFunds).
 * Signing reuses the unit-tested helper in src/modules/providers/avenia/signing.ts.
 * Endpoint paths follow https://integration-guide.avenia.io — NOTE the ticket
 * endpoints carry a TRAILING SLASH and the signed request_uri must match the sent
 * URI byte-for-byte (Confluence "Avenia Connectivity", integration guide Security).
 *
 * Safety tiers:
 *   read-only : selfcheck, probe, quote, tickets, subaccounts        — run freely
 *   durable   : subaccount-create (IRREVERSIBLE — no delete), ticket-create,
 *               ticket-cancel                                        — require --execute
 * Sandbox: a PIX-in ticket ≤ R$1,000 is AUTO-PAID by a simulated payer within
 * seconds (this is the sandbox faucet); above R$1,000 it stays UNPAID forever.
 *
 * Usage: node --import tsx scripts/avenia/cli.ts <command> [flags]
 */
import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey, createPublicKey, createVerify } from "node:crypto";
import { signAveniaRequest, aveniaSignedHeaders } from "../../src/modules/providers/avenia/signing.js";

// --- env / key loading (deliberately NOT src/config/env.ts — that fail-fasts on DATABASE_URL) ---

if (!process.env.AVENIA_API_KEY) {
  try { process.loadEnvFile(); } catch { /* no .env — rely on exported vars */ }
}

const BASE = process.env.AVENIA_BASE_URL ?? "https://api.sandbox.avenia.io:10952";
const API_KEY = process.env.AVENIA_API_KEY ?? "";

/** Resolve the signing key from (a) AVENIA_SIGNING_KEY_FILE path, (b) PEM with literal
 *  or \n-escaped newlines, (c) base64-encoded PEM. .env cannot hold raw multi-line PEMs
 *  and truncates unquoted '#' — see README. */
function resolvePrivateKeyPem(): string {
  const file = process.env.AVENIA_SIGNING_KEY_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  let raw = process.env.AVENIA_SIGNING_PRIVATE_KEY ?? "";
  if (!raw) fail("no signing key: set AVENIA_SIGNING_KEY_FILE=secrets/avenia.pem or AVENIA_SIGNING_PRIVATE_KEY (see scripts/avenia/README.md)");
  if (raw.includes("\\n")) raw = raw.replaceAll("\\n", "\n");
  if (raw.startsWith("-----")) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.startsWith("-----")) return decoded;
  fail("AVENIA_SIGNING_PRIVATE_KEY is neither a PEM nor base64-encoded PEM");
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// --- tiny arg parser: positional command + --flag value / --flag ---

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string | true>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (!a.startsWith("--")) continue;
  const next = rest[i + 1];
  if (next && !next.startsWith("--")) { flags.set(a.slice(2), next); i++; }
  else flags.set(a.slice(2), true);
}
const flag = (name: string, dflt?: string): string | undefined =>
  typeof flags.get(name) === "string" ? (flags.get(name) as string) : dflt;

// --- signed fetch: the URI string used for signing is the EXACT string sent (query included) ---

async function signedFetch(method: string, requestUri: string, bodyObj?: unknown): Promise<{ status: number; body: unknown }> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const headers = aveniaSignedHeaders(API_KEY, { method, requestUri, body, privateKeyPem: resolvePrivateKeyPem() });
  const res = await fetch(`${BASE}${requestUri}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
  console.log(`${method} ${requestUri} -> ${res.status}`);
  return { status: res.status, body: parsed };
}

function show(body: unknown): void {
  console.log(JSON.stringify(body, null, 2));
}

function withSub(path: string): string {
  const sub = flag("sub");
  return sub ? `${path}${path.includes("?") ? "&" : "?"}subAccountId=${encodeURIComponent(sub)}` : path;
}

function quoteQuery(): URLSearchParams {
  const q = new URLSearchParams({
    inputCurrency: flag("in", "BRL")!,
    inputPaymentMethod: flag("inMethod", "PIX")!,
    outputCurrency: flag("out", "BRLA")!,
    outputPaymentMethod: flag("outMethod", "INTERNAL")!,
    inputAmount: flag("amount", "100")!,
    inputThirdParty: "false", // both must be false today (integration guide, quotesAndTickets)
    outputThirdParty: "false",
  });
  // Docs' mock-funds example includes this even for PIX->INTERNAL; required for blockchain inputs.
  const send = flag("sendMethod", "PERMIT");
  if (send) q.set("blockchainSendMethod", send);
  return q;
}

// --- commands ---

async function selfcheck(): Promise<void> {
  // Offline: key parses, signature verifies against the derived public key, api key shape.
  const pem = resolvePrivateKeyPem();
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv);
  const { timestamp, signature } = signAveniaRequest({ method: "GET", requestUri: "/v2/selfcheck", privateKeyPem: pem });
  const v = createVerify("RSA-SHA256");
  v.update(timestamp + "GET" + "/v2/selfcheck");
  v.end();
  const ok = v.verify(pub, signature, "base64");
  console.log(`key type=${priv.asymmetricKeyType} bits=${priv.asymmetricKeyDetails?.modulusLength ?? "n/a"}`);
  console.log(`api key: ${API_KEY ? `${API_KEY.slice(0, 8)}… (${API_KEY.length} chars)` : "MISSING"}`);
  console.log(`base url: ${BASE}`);
  console.log(ok ? "✓ signature round-trips against derived public key" : "✗ signature verification FAILED");
  if (!ok || !API_KEY) process.exit(1);
}

async function probe(): Promise<void> {
  // Read-only recon of the main account — every path CONFIRMED by the integration guide.
  // 401/403 = key or signing wrong (stop, fix); 200s prove the whole auth chain.
  const paths = [
    "/v2/account/account-info", // account + Avenia wallets + PIX BR Code
    "/v2/account/balances",     // keys: ARSA BRLA EURC USDC USDM USDT
    "/v2/account/metadata",     // brlUnlocked/usdUnlocked/eurUnlocked flags
    "/v2/account/limits",       // monthly in/out limits + used, per currency
    "/v2/account/sub-accounts", // list (response key: subAccount)
    "/v2/account/tickets/",     // trailing slash per docs — part of the signed URI
  ];
  for (const path of paths) {
    const { body } = await signedFetch("GET", withSub(path));
    show(body);
  }
  console.log("\nAny 401/403 above = key/signing problem. All 200s = full auth chain verified.");
}

async function quote(): Promise<void> {
  const { body } = await signedFetch("GET", withSub(`/v2/account/quote/fixed-rate?${quoteQuery()}`));
  show(body);
  console.log("\nNote: quoteToken is valid ~15s; appliedFees[] is the itemized no-spread breakdown.");
}

async function tickets(): Promise<void> {
  const id = flag("id");
  const path = id ? `/v2/account/tickets/${id}` : "/v2/account/tickets/";
  const { body } = await signedFetch("GET", withSub(path));
  show(body);
}

async function subaccounts(): Promise<void> {
  const { body } = await signedFetch("GET", withSub("/v2/account/sub-accounts"));
  show(body);
}

async function subaccountCreate(): Promise<void> {
  const name = flag("name") ?? fail("--name required (the org's razão social)");
  if (flags.get("execute") !== true) fail("creates a PERMANENT subaccount (Avenia has no delete) — re-run with --execute");
  const type = flag("type", "COMPANY")!; // COMPANY per Confluence §1; docs examples show INDIVIDUAL
  const { body } = await signedFetch("POST", "/v2/account/sub-accounts", { accountType: type, name });
  show(body);
}

async function ticketCreate(): Promise<void> {
  if (flags.get("execute") !== true) {
    fail("creates a ticket — sandbox AUTO-PAYS PIX-in ≤ R$1,000 within seconds (the faucet) — re-run with --execute");
  }
  const amount = Number(flag("amount", "100"));
  if (amount > 1000) console.log("⚠ sandbox auto-payer only pays ≤ R$1,000 — this ticket will stay UNPAID");
  // Quote → ticket inside the 15s token window. Default: BRL PIX-in resting as BRLA on
  // this account (nil-UUID beneficiaryWalletId = "current operating account").
  const quoteRes = await signedFetch("GET", withSub(`/v2/account/quote/fixed-rate?${quoteQuery()}`));
  const quoteToken = (quoteRes.body as { quoteToken?: string })?.quoteToken;
  if (!quoteToken) { show(quoteRes.body); fail("no quoteToken in quote response"); }
  const { body } = await signedFetch("POST", withSub("/v2/account/tickets/"), {
    quoteToken,
    ticketBlockchainOutput: { beneficiaryWalletId: "00000000-0000-0000-0000-000000000000" },
  });
  show(body);
  console.log("\nTrack it: cli.ts tickets --id <id>   (UNPAID -> PROCESSING -> PAID; auto-paid in sandbox ≤ R$1,000)");
}

async function ticketCancel(): Promise<void> {
  const id = flag("id") ?? fail("--id required");
  if (flags.get("execute") !== true) fail("mutates ticket state (only works while UNPAID) — re-run with --execute");
  const { body } = await signedFetch("PATCH", withSub(`/v2/account/tickets/${id}/cancel`));
  show(body);
}

async function webhooks(): Promise<void> {
  const { body } = await signedFetch("GET", "/v2/notifications/webhooks/");
  show(body);
}

async function webhookRegister(): Promise<void> {
  const url = flag("url") ?? fail("--url required (public HTTPS endpoint, e.g. https://…/webhooks/avenia)");
  if (flags.get("execute") !== true) fail("registers a webhook URL (max 3 per account) — re-run with --execute");
  const subs = flag("subs", "TICKET")!.split(",");
  const { body } = await signedFetch("POST", "/v2/notifications/webhooks/", { webhookUrl: url, subscriptions: subs });
  show(body);
}

async function webhookDelete(): Promise<void> {
  const id = flag("id") ?? fail("--id required");
  if (flags.get("execute") !== true) fail("deletes a webhook registration — re-run with --execute");
  const { body } = await signedFetch("DELETE", `/v2/notifications/webhooks/${id}`);
  show(body);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  selfcheck, probe, quote, tickets, subaccounts, webhooks,
  "subaccount-create": subaccountCreate,
  "ticket-create": ticketCreate,
  "ticket-cancel": ticketCancel,
  "webhook-register": webhookRegister,
  "webhook-delete": webhookDelete,
};

const run = COMMANDS[cmd ?? ""];
if (!run) {
  console.log(`Avenia sandbox CLI — main/master account (omit --sub) or --sub <subAccountId>

read-only:  selfcheck | probe | quote [--in BRL --inMethod PIX --out BRLA --outMethod INTERNAL --amount 100] | tickets [--id <id>] | subaccounts | webhooks
durable:    subaccount-create --name "Empresa LTDA" [--type COMPANY] --execute   (PERMANENT — no delete)
            ticket-create [--amount 100] --execute                               (sandbox auto-pays ≤ R$1,000)
            ticket-cancel --id <id> --execute
            webhook-register --url https://host/webhooks/avenia [--subs TICKET] --execute
            webhook-delete --id <id> --execute

env: AVENIA_API_KEY + (AVENIA_SIGNING_KEY_FILE | AVENIA_SIGNING_PRIVATE_KEY) [+ AVENIA_BASE_URL]
Start with: selfcheck (offline), then probe. Docs: https://integration-guide.avenia.io`);
  process.exit(cmd ? 1 : 0);
}
run().catch((e) => fail(e instanceof Error ? e.message : String(e)));
