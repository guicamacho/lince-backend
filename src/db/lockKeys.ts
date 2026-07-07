/**
 * Advisory-lock key registry (PRD-07 §2 pattern 1). ONE place so keys never collide.
 *
 * Lock-ordering invariant: take the advisory org lock FIRST, then any row locks — never the
 * reverse. And NEVER an external call while a lock is held (enforced structurally by the
 * two-phase payout: locks in Phase 1, the Avenia call in Phase 2 with no locks held).
 *
 * `pg_advisory_xact_lock` auto-releases at transaction end. `hashtext()` returns int4 which
 * auto-casts to the single-arg int8 overload.
 */
import type pg from "pg";

export const orgMoneyLockArg = (orgId: string): string => `org-money:${orgId}`;
export const orgOnboardingLockArg = (key: string): string => `org-onboarding:${key}`;

async function acquireXactLock(client: pg.PoolClient, arg: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [arg]);
}

/** Serialize every balance-mutating op for an org (payouts, swaps, closure zero-balance check). */
export const acquireOrgMoneyLock = (client: pg.PoolClient, orgId: string): Promise<void> =>
  acquireXactLock(client, orgMoneyLockArg(orgId));

/** Serialize onboarding for a company. Keyed by org id (F4 avenia forward) or by CNPJ (signup,
 *  before an org id exists). Distinct key spaces so the two uses never collide. */
export const acquireOrgOnboardingLock = (client: pg.PoolClient, key: string): Promise<void> =>
  acquireXactLock(client, orgOnboardingLockArg(key));
