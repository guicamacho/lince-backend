/**
 * Sync a Clerk user into a `people` row (operational identity ONLY — Modelo A: no KYC PII).
 * Driven by the signature-verified Clerk webhook (user.created / user.updated). Idempotent.
 */
import { pool, withTransaction } from "../../db/pool.js";

export interface ClerkUserEvent {
  type: string;
  data: {
    id: string;
    email_addresses?: { id: string; email_address: string }[];
    primary_email_address_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  };
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

  return withTransaction(async (c) => {
    const linked = await c.query<{ id: string }>("select id from people where clerk_user_id = $1", [clerkUserId]);
    if (linked.rows[0]) {
      await c.query("update people set full_name = $2, updated_at = now() where id = $1", [linked.rows[0].id, fullName]);
      return linked.rows[0].id;
    }

    const existing = await c.query<{ id: string }>(
      "select id from people where lower(email) = $1 and can_login = true and clerk_user_id is null limit 1",
      [email],
    );
    if (existing.rows[0]) {
      await c.query("update people set clerk_user_id = $2, full_name = $3, updated_at = now() where id = $1", [
        existing.rows[0].id,
        clerkUserId,
        fullName,
      ]);
      // A pre-created invitee (PRD-03 F1) just accepted: their pending memberships go live.
      await c.query("update org_people set status = 'active' where person_id = $1 and status = 'invited'", [
        existing.rows[0].id,
      ]);
      return existing.rows[0].id;
    }

    const created = await c.query<{ id: string }>(
      "insert into people (clerk_user_id, full_name, email, can_login) values ($1, $2, $3, true) returning id",
      [clerkUserId, fullName, email],
    );
    return created.rows[0]!.id;
  });
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
