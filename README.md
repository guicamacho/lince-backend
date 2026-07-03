# Lince Finance — Phase 1

B2B cross-border payments for Brazilian companies (PJ only), on the **Avenia rail**.
Modular monolith · TypeScript · Postgres.

**Read `BUILD_BRIEF.md` first.** It defines what to build now, what is deliberately
stubbed, and the **Modelo A guardrails** that must not be undone. The regulatory model
(Confluence page 250904599) governs everything.

## Quick start (local dev)
```bash
npm install
cp .env.example .env                        # DATABASE_URL defaults to local lince_dev
createdb lince_dev && createdb lince_test   # local Postgres 16
npm run migrate                             # apply db/migrations/*.sql to lince_dev
npm run typecheck
npm test                                    # node:test against lince_test (auto-migrated, runs serially)
npm run dev                                 # http://localhost:3000
```

`.env` is loaded automatically (Node `loadEnvFile`) only when `DATABASE_URL` is not already
set, so the test run (which sets `lince_test` inline) never touches the dev DB.

### Routes (Phase 1)
- `GET  /healthz` — liveness + DB ping
- `POST /onboarding/bootstrap` — authed (Clerk) signup bootstrap → person + `pending_lince_approval` org + owner
- `POST /webhooks/:provider` — persists the raw event **only** (processing gated/stubbed)
- `POST /admin/orgs/:id/access` — suspend/block/reinstate an org (service-token gated, audited)
- `GET  /app/*` — behind the **active-org gate**. Dev auth seam: `x-org-id` header; real Clerk session→org resolution is a later milestone (PRD-02).

## What's here
- `db/migrations/0001_init.sql` — the validated 18-table schema (Modelo A state).
- `src/modules/ledger` — double-entry core (the spine of all money).
- `src/modules/access` — the binary `org.state=active` gate.
- `src/modules/onboarding/admission.service.ts` — the Avenia-verdict **relay** action.
- `src/modules/providers` — Avenia signing harness + interfaces; vendor calls **stubbed**.
- `src/modules/access/access.service.ts` — suspend/block/reinstate write path (0002 seam), audited.
- `src/modules/identity/org.state.ts` — org lifecycle + `canTransition`/`assertTransition` guard.
- `src/app.ts` — Express server (health, onboarding, webhook intake, the gate).
- `test/` — `node:test` suites proving the safety floor (money, ledger balanced/append-only, admission relay, access, transitions).

## What's NOT here (stubbed — see BUILD_BRIEF §3)
Live Avenia money flows, Didit integration, back-office UI, USD/EUR rail-unlocks,
cards, MX/CO. Each is gated on a confirmation we don't have yet.
