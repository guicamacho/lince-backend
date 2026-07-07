# Avenia sandbox test CLI

Exercises the Avenia API with the Lince **main (master) account**, which is already
KYB'd and approved on Avenia's side. Master-account calls omit `?subAccountId=`;
pass `--sub <id>` to scope any command to a COMPANY subaccount.

Signing reuses `src/modules/providers/avenia/signing.ts` (RSA PKCS#1 v1.5 SHA-256
over `timestamp + METHOD + path-with-query + body`), the scheme unit-tested in
`test/aveniaSigning.test.ts` and documented in Confluence
"Avenia Connectivity & API Keys" (LF space, page 247988342).

## Keys — read this before pasting anything into .env

`.env` (parsed by Node's `process.loadEnvFile`) **cannot hold raw multi-line PEMs**
and **truncates unquoted values at `#`**. Pick ONE:

1. **File (recommended):** save the PEM to `secrets/avenia.pem` (gitignored) and set
   `AVENIA_SIGNING_KEY_FILE=secrets/avenia.pem`
2. Single line with escaped newlines:
   `AVENIA_SIGNING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"`
3. Base64 of the whole PEM file: `AVENIA_SIGNING_PRIVATE_KEY=LS0tLS1CRUdJTi...`

Plus `AVENIA_API_KEY=<uuid>` (double-quote it if it ever contains `$` or `#` — the
admin service token was once silently truncated by exactly that).
`AVENIA_BASE_URL` defaults to the sandbox (`https://api.sandbox.avenia.io:10952`).

## Run order

```sh
node --import tsx scripts/avenia/cli.ts selfcheck   # offline: key parses, signature round-trips
node --import tsx scripts/avenia/cli.ts probe       # read-only: auth + endpoint recon
node --import tsx scripts/avenia/cli.ts quote       # read-only: BRL 100 PIX -> BRLA, fee breakdown
node --import tsx scripts/avenia/cli.ts tickets     # read-only: ticket list
```

`probe` hits six read-only endpoints confirmed by the official integration guide
(account-info, balances, metadata, limits, sub-accounts, tickets). Interpretation:
**401/403 = key or signing wrong** (stop, fix); all 200s = the full auth chain
(key, signing, timestamp) is verified against real Avenia.

## Durable commands (create real objects in the sandbox)

Gated behind `--execute`; they refuse to run without it.

```sh
node --import tsx scripts/avenia/cli.ts subaccount-create --name "Empresa Teste LTDA" --execute
node --import tsx scripts/avenia/cli.ts ticket-create --amount 50 --execute
node --import tsx scripts/avenia/cli.ts ticket-cancel --id <id> --execute
```

Subaccounts are **permanent** (Avenia exposes no delete), so create sparingly.

`ticket-create` quotes then opens a **PIX-in deposit ticket** on the account, per
the quote→ticket model (every money movement is a quote→ticket; there are no
separate deposit/payout endpoints). **In sandbox, PIX-in tickets ≤ R$1,000 are
auto-paid by a simulated payer within seconds** — this is the official way to
fund test balances (the faucet). Above R$1,000 the ticket stays UNPAID forever.
The `quoteToken` is only valid ~15 seconds, so the CLI quotes and opens the
ticket in one run.

Endpoint paths come from the official guide (https://integration-guide.avenia.io);
note the ticket endpoints use a **trailing slash**, and the signed `request_uri`
must match the sent URI byte-for-byte, so don't "clean up" the paths.

## What this harness is for

Validate, before wiring anything into the product: (1) the key + signing round-trip
against real Avenia, (2) the exact response shapes (`appliedFees[]`, `quoteToken`,
ticket lifecycle) that `avenia.client.ts` stubs will implement, (3) open questions
from the Confluence register — deposit brCode vs persistent PIX key (#1), rate
limits / 429 semantics (#10), sandbox currencies.
