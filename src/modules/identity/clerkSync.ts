/**
 * Sync a Clerk user into a `people` row (operational identity ONLY — Modelo A: no KYC PII).
 * Driven by the signature-verified Clerk webhook (user.created / user.updated). Idempotent.
 *
 * RECOVERY-HOLD TRIGGER (Cluster 2, PRD-07 §3.5): Clerk emits no clean "account was
 * recovered" event, so the durable signal is a DIFF of the user's security flags against
 * the last snapshot we stored (people.security_snapshot, migration 0017). Two takeover
 * patterns register the 24h money-out hold for EVERY org the person belongs to:
 *   - a second factor that was enrolled disappears (two_factor_enabled true -> false);
 *   - the primary email address is swapped.
 * Redelivery-safe: the snapshot updates in the same tx as the hold, so replaying the same
 * webhook diffs identical states and does nothing. A password reset alone is NOT detectable
 * from Clerk's payload (no password-change marker) — documented limitation.
 */
import type pg from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { registerPostRecoveryHold, RECOVERY_HOLD_HOURS } from "../access/recoveryHold.js";
import { enqueueNotification } from "../notifications/outbox.js";

export interface ClerkUserEvent {
  type: string;
  data: {
    id: string;
    email_addresses?: { id: string; email_address: string }[];
    primary_email_address_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    two_factor_enabled?: boolean;
    totp_enabled?: boolean;
    backup_code_enabled?: boolean;
    password_enabled?: boolean;
  };
}

/** What we persist per person to diff future events against. */
interface SecuritySnapshot {
  two_factor_enabled?: boolean;
  primary_email_address_id?: string | null;
}

function snapshotOf(d: ClerkUserEvent["data"]): SecuritySnapshot | null {
  // Only snapshot when the payload actually carries the security fields (link-on-login
  // fetches and older stored events may not) — never overwrite a real snapshot with blanks.
  if (d.two_factor_enabled === undefined && d.primary_email_address_id === undefined) return null;
  return {
    two_factor_enabled: d.two_factor_enabled,
    primary_email_address_id: d.primary_email_address_id ?? null,
  };
}

/** The tight trigger rule — pure, unit-testable. */
export function recoveryDetected(prior: SecuritySnapshot | null, now: SecuritySnapshot | null): boolean {
  if (!prior || !now) return false;
  const factorRemoved = prior.two_factor_enabled === true && now.two_factor_enabled === false;
  const emailSwapped =
    !!prior.primary_email_address_id &&
    !!now.primary_email_address_id &&
    prior.primary_email_address_id !== now.primary_email_address_id;
  return factorRemoved || emailSwapped;
}

function primaryEmail(d: ClerkUserEvent["data"]): string | null {
  const list = d.email_addresses ?? [];
  const chosen = list.find((e) => e.id === d.primary_email_address_id) ?? list[0];
  return chosen?.email_address?.trim().toLowerCase() ?? null;
}

/**
 * Link a Clerk user to a `people` row:
 *  1) already linked (by clerk_user_id)            -> refresh display name;
 *  2) an existing login-person, same email, no link -> attach the clerk_user_id
 *     (this is how a pre-screened legal rep's account gets connected);
 *  3) otherwise                                     -> create a new login person.
 * Returns people.id, or null if the event isn't a `user.*` event or has no email.
 */
export async function linkClerkUserFromEvent(event: ClerkUserEvent): Promise<string | null> {
  if (event.type !== "user.created" && event.type !== "user.updated") return null;
  const clerkUserId = event.data.id;
  const email = primaryEmail(event.data);
  if (!email) return null;
  const fullName =
    [event.data.first_name, event.data.last_name].filter((s) => s && s.trim()).join(" ").trim() || email;

  const snap = snapshotOf(event.data);
  return withTransaction(async (c) => {
    // FOR UPDATE: serialize concurrent deliveries for the same person so two user.updated
    // events can't both diff against the same stale snapshot.
    const linked = await c.query<{ id: string; email: string; security_snapshot: SecuritySnapshot | null }>(
      "select id, email, security_snapshot from people where clerk_user_id = $1 for update",
      [clerkUserId],
    );
    if (linked.rows[0]) {
      const person = linked.rows[0];
      if (event.type === "user.updated" && snap && recoveryDetected(person.security_snapshot, snap)) {
        await triggerRecoveryHold(c, person.id, person.email, email);
      }
      await c.query(
        "update people set full_name = $2, security_snapshot = coalesce($3, security_snapshot), updated_at = now() where id = $1",
        [person.id, fullName, snap ? JSON.stringify(snap) : null],
      );
      return person.id;
    }

    const existing = await c.query<{ id: string }>(
      "select id from people where lower(email) = $1 and can_login = true and clerk_user_id is null limit 1",
      [email],
    );
    if (existing.rows[0]) {
      await c.query(
        "update people set clerk_user_id = $2, full_name = $3, security_snapshot = coalesce($4, security_snapshot), updated_at = now() where id = $1",
        [existing.rows[0].id, clerkUserId, fullName, snap ? JSON.stringify(snap) : null],
      );
      // A pre-created invitee (PRD-03 F1) just accepted: their pending memberships go live.
      await c.query("update org_people set status = 'active' where person_id = $1 and status = 'invited'", [
        existing.rows[0].id,
      ]);
      return existing.rows[0].id;
    }

    const created = await c.query<{ id: string }>(
      "insert into people (clerk_user_id, full_name, email, can_login, security_snapshot) values ($1, $2, $3, true, $4) returning id",
      [clerkUserId, fullName, email, snap ? JSON.stringify(snap) : null],
    );
    return created.rows[0]!.id;
  });
}

/**
 * Register the 24h hold on every org the person can act in, and notify. The security
 * notice goes to the STORED (pre-event) email — on a primary-email swap that is the
 * real owner's address — and additionally to the new address when it differs, so a
 * legitimate change still reaches the user.
 */
async function triggerRecoveryHold(
  c: pg.PoolClient,
  personId: string,
  storedEmail: string,
  eventEmail: string,
): Promise<void> {
  const { rows: orgs } = await c.query<{ org_id: string }>(
    `select org_id from org_people where person_id = $1 and status = 'active'`,
    [personId],
  );
  for (const o of orgs) {
    await registerPostRecoveryHold(o.org_id, RECOVERY_HOLD_HOURS, personId, c);
  }
  const recipients = new Set([storedEmail.toLowerCase(), eventEmail.toLowerCase()]);
  for (const to of recipients) {
    await enqueueNotification(c, { eventType: "post_recovery_hold", recipientRef: to, templateId: "post_recovery_hold" });
  }
}

/** Raw Clerk user fetch, shaped like the webhook payload (raw API — the SDK drops fields). */
async function fetchClerkUser(userId: string): Promise<ClerkUserEvent["data"] | null> {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY ?? ""}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ClerkUserEvent["data"];
}

/**
 * Link-on-login fallback. The invited→active flip normally rides the Clerk user.created
 * webhook, but webhooks point at the DEPLOYED backend (never a local one) and can race the
 * invitee's very first request in any environment. When a session's clerk_user_id has no
 * people row, resolve the user from Clerk and run the SAME linking the webhook would.
 * Idempotent; one indexed SELECT when already linked; best-effort (a Clerk outage falls
 * through to the caller's normal no-org handling). `fetchUser` injectable for tests.
 */
export async function ensureClerkUserLinked(
  clerkUserId: string,
  fetchUser: (id: string) => Promise<ClerkUserEvent["data"] | null> = fetchClerkUser,
): Promise<void> {
  const { rows } = await pool.query("select 1 from people where clerk_user_id = $1", [clerkUserId]);
  if (rows[0]) return;
  try {
    const data = await fetchUser(clerkUserId);
    if (data) await linkClerkUserFromEvent({ type: "user.created", data: { ...data, id: clerkUserId } });
  } catch {
    /* best-effort — the webhook remains the durable path */
  }
}
