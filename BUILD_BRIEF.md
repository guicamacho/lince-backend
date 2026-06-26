# Lince Finance — Phase 1 Build Brief (Claude Code handoff)

> **Purpose.** A focused kickoff for building the Phase 1 spine. Read this first. It defines **what to build now**, **what is deliberately stubbed** (and why), and the **Modelo A guardrails you must not undo**. The schema is already written and Postgres-validated.

---

## 0 · Source of truth

The **Confluence pages are canonical** — not any `.md` files on disk (some on-disk docs predate the current design and are stale).

| Doc | Confluence page | Role |
| --- | --- | --- |
| **Regulatory Operating Model — BCB Modelo A** | 250904599 | **The guardrail.** Governs everything. On any conflict, it wins. |
| Onboarding & KYB (PRD-01 v5.1) | 247890087 | Onboarding flow, Didit, Avenia forward, admission relay |
| Database Schema v1.1 (additions) | 249430018 | The v1.0 + v1.1 migration deltas |
| Database Schema (base companion) | 247758870 | The base 15-table reference |
| Admin Portal (PRD-04 v2) | 247758901 | Back-office, the relay action, SLA instrumentation |
| Authentication (PRD-02) | 247922755 | Clerk + sessions + access |
| RBAC & Team (PRD-03) | 247726171 | Customer RBAC |
| Solution Architecture — Phase 1 | 248971266 | BRLA-correct architecture (use this, **not** the on-disk arch .md) |
| Avenia Connectivity | 247988342 | Avenia API specifics (quote→ticket, signing) |

Site: `billr-aus.atlassian.net`. The schema in this repo (`db/migrations/0001_init.sql`) already folds the base + v1.0 + v1.1 into one validated file — **use it as the migration**, it supersedes the on-disk `Lince_Schema_Phase1.sql`.

---

## 1 · What the product is (one paragraph)

**Lince Finance** (brand) / **Billr** (entity) — a B2B cross-border payments platform for **Brazilian companies (PJ only)**. Phase 1 runs entirely on the **Avenia rail**: BRL **PIX pay-in → rests as BRLA** (Avenia's BRL stablecoin, displayed as R$) → **on-demand swap → multi-currency payout** (USDC/USDT in sandbox; USD/EUR are production rail-unlocks). **Pass-through, no float at Lince. Avenia custodies everything; Lince never holds keys or spread.** Pattern: **modular monolith**, TypeScript + Postgres (primary in São Paulo / `gru`), Clerk auth, Fly.io.

---

## 2 · Build now — the spine (zero external dependencies)

Everything here is buildable **today** with no blocked vendor confirmations. Suggested order:

1. **Migration + DB plumbing.** Apply `db/migrations/0001_init.sql` (18 tables, validated). Wire the pool (`src/db/pool.ts`) and a trivial migration runner (`db/migrate.ts`).
2. **Money primitives.** `src/money/money.ts` — signed `bigint` minor units, per-currency decimals (BRL/USD/EUR = 2, USDC/USDT = 6). **Never floats.**
3. **Ledger core.** `src/modules/ledger/` — `postBalancedTransaction()` (writes a `ledger_transaction` + balanced `ledger_postings`, Σ per currency = 0, enforced by the DB trigger) and `balanceOf()` = `SUM(amount)` (no balance column). This is the spine of all money.
4. **Access gate.** `src/modules/access/requireActiveOrg.ts` — the single binary middleware: no app surface unless `org.state = 'active'`.
5. **Identity + admission state machine (skeleton).** `src/modules/identity/org.state.ts` — org lifecycle + the admission record. Vendor calls **stubbed** behind interfaces.
6. **Admission relay action.** `src/modules/onboarding/admission.service.ts` — `recordAveniaVerdict()` writes `orgs.admission_*` and an `audit_log` entry **marked as a relay**. (This is the back-office action from your "approve BR manually once Avenia answers".)
7. **Provider registry + Avenia client harness.** `src/modules/providers/` — the `KybProvider` / `RailProvider` interfaces, plus the Avenia client **signing harness** (RSA PKCS#1 v1.5 SHA-256 over full path+query) and the quote→ticket **types**. The actual money calls are stubbed (see §3).

Auth (Clerk) is plumbing only at this stage: wire `people.clerk_user_id` / `admin_users.clerk_user_id` and session validation per PRD-02; no regulated PII crosses the Clerk boundary.

---

## 3 · Do NOT build yet — stubbed, and why

Each of these is gated on a confirmation we don't have. Leave the **interface** in place; stub the implementation with a clear `throw new Error('STUB: gated on …')`. Building against unknowns now is wasted effort.

| Stubbed | Gated on |
| --- | --- |
| **Live Avenia money flows** (deposit / swap / payout execution) | Avenia **Wallets / Operations** API mapping — not yet fetched (PIX pay-in mechanics, beneficiary creation, payout execution). |
| **Didit integration** (capture + forward) | Vendor confirmation: **CNPJ registry coverage** (every Didit example seen was UK), webhook payloads, the **Didit→Avenia transfer mechanism**, AML scope. |
| **Back-office UI** (the relay screen, queues, aging view) | Admin-auth mechanism decision (separate Clerk org vs IdP) + final cases workflow. The relay **service** can be built; the **UI** waits. |
| **USD/EUR rail-unlocks** | Production-only at Avenia (PoFC + Proof-of-Revenue); not testable in sandbox. |
| **Cards (PRD-05)** | A later phase by design — not Phase 1. |
| **MX / CO markets** | Local counsel (CNBV / Ley Fintech, SFC). The `admission_authority` seam exists; the markets are config-gated and must not go live. |

---

## 4 · Modelo A guardrails — do not "helpfully" undo these

These are load-bearing for the regulatory model. The schema already encodes them; keep the application code consistent. **If a change seems to require breaking one of these, stop and flag it — it's a regulatory decision, not a refactor.**

1. **No KYC PII at Lince.** There is no `cpf`, no `kyc_status`, no UBO `ownership_pct`, no documents table — on purpose. PII is forwarded to Didit/Avenia and **never stored**. Do not add a CPF column "for convenience." Lince holds references + status only.
2. **Admission is Avenia's, recorded as a relay.** `recordAveniaVerdict()` writes Avenia's decision (`admission_authority_used='avenia'`, `admission_external_ref`, `admission_recorded_by`) and logs it **as a relay**. There must be **no code path where Lince makes its own BR admission decision**. The pre-screen is **completeness-only** (no risk criteria).
3. **No FX spread at Lince.** Lince earns the **Avenia rebate**, never a câmbio spread. Do not model a spread/net-profit anywhere. Revenue = realized rebate on a PAID ticket.
4. **Avenia is the principal to the user.** Presentation is "Powered by Avenia"; the user contracts with Avenia. (Front-end concern, but keep copy/ToS consistent.)
5. **AML/sanctions for BR is Avenia's.** `cases` carries an **operational** taxonomy only (`kyb_completeness`, `avenia_decision_relay`, `rfi_relay`, `beneficiary_review`, `support`, `manual_review`). No Lince-owned `aml_alert`/`sanctions_hit`/`pep_match`/`sar` type for BR. (The AUSTRAC↔BCB tension is unresolved — for counsel.)
6. **Per-jurisdiction admission.** `jurisdiction_policies.admission_authority` decides who admits. **BR = `avenia`** (locked). MX/CO rows are intentionally **unseeded** — gated on counsel.

---

## 5 · Schema notes & one open reconciliation

- **18 tables**, validated on Postgres 16 (full DDL + functional checks: balanced commit, unbalanced rejection, append-only, single-owner index, the admission relay record, the cases taxonomy, and absence of the PII columns).
- **`org.kyb_forwarded_at`** is the timestamp the KYB L1 was forwarded to Avenia; with `admission_recorded_at` it drives the **admission-aging / SLA instrument** (PRD-04 §4.3/§10 — the Avenia-latency evidence base). Index `orgs_admission_pending_ix` backs the aging view.
- **⚠ Reconciliation made:** `org_people.ownership_pct` was **dropped** (UBO ownership % is KYC data forwarded to Avenia/Didit per PRD-01 v5 §9; the v1.1 additions DDL had missed it). If a team-view display genuinely needs it, it's a one-line re-add — **confirm before relying on it either way.**

---

## 6 · The questions that unblock the stubs

These are the real-world confirmations that turn stubs into implementations (tracked on the canon + PRDs):

- **Avenia:** the **Wallets/Operations** API mapping (unblocks money flows); an **admission decision SLA** + whether a **reliable async decision webhook** exists (the KYB call doesn't return a verdict — today the relay is manual); **express câmbio authorization** in their BCB request; production base URL; Bridge industry codes.
- **Didit:** BR-CNPJ / MX / CO **registry coverage**; webhook payloads; the **Didit→Avenia transfer mechanism**; AML scope; contracting structure (by Avenia is cleanest).
- **Counsel:** **AUSTRAC ↔ BCB** AML/SMR boundary; **MX/CO** local analysis; the KYC-PII retention boundary + multi-party DPA.

---

## 7 · Repo layout

```
lince-phase1/
  db/migrations/0001_init.sql     # ✅ validated 18-table migration (the schema)
  db/migrate.ts                   # minimal ordered-SQL runner
  src/
    config/env.ts                 # env loading + validation
    db/pool.ts                    # pg Pool
    money/money.ts                # minor-units helpers (no floats)
    modules/
      ledger/                     # double-entry: postBalancedTransaction(), balanceOf()
      identity/org.state.ts       # org lifecycle + admission state machine (skeleton)
      access/requireActiveOrg.ts  # binary org.state=active gate
      onboarding/admission.service.ts  # recordAveniaVerdict() — the relay action
      providers/
        provider.types.ts         # KybProvider / RailProvider interfaces
        avenia/                    # signing harness + quote→ticket types (calls STUBBED)
        didit/                     # DiditProvider interface (STUBBED)
    app.ts                        # wiring placeholder
  package.json  tsconfig.json  .env.example  .gitignore  README.md
```

Stubs are marked in-code with `throw new Error('STUB: gated on …')` and a comment pointing at the §6 confirmation that unblocks them. Build the spine (§2); leave the stubs (§3); respect the guardrails (§4).
