/**
 * Clerk invitation I/O for team invites (PRD-03 F1).
 *
 * Clerk has no "resend" API — the documented way to re-send is revoke + recreate. And a plain
 * create returns `duplicate_record` when a pending invitation for the email already exists (e.g.
 * a member was removed but their Clerk invite was left dangling, or a multi-org invitee). So
 * `sendFreshInvitation` always lands a *new* email: it recreates on duplicate. `revokeInvitationsFor`
 * cleans up on removal so state doesn't drift.
 *
 * redirect_url points the invite email at OUR /sign-up page (<SignUp> consumes __clerk_ticket to
 * pre-fill + accept), not Clerk's hosted Account Portal.
 */
import { env } from "../../config/env.js";

const API = "https://api.clerk.com/v1/invitations";
const authHeaders = () => ({
  Authorization: `Bearer ${env.clerk.secretKey ?? ""}`,
  "Content-Type": "application/json",
});
/** The invite email deep-links to /sign-up?invited=<email>: the ticket JWT carries no email, so
 *  the query param is how the sign-up page shows "Convite para <email>" as a UI reference
 *  (display-only; Clerk binds the actual signup email to the ticket regardless). */
export function inviteRedirectUrl(base: string, email: string): string {
  return `${base}/sign-up?invited=${encodeURIComponent(email)}`;
}
const redirectUrl = (email: string) => (env.customerAppUrl ? inviteRedirectUrl(env.customerAppUrl, email) : undefined);

/**
 * Should a failed Clerk create be treated as "a pending invitation already exists" (recreatable)
 * rather than a hard failure? True ONLY for a 4xx carrying `duplicate_record`; a 5xx (even a
 * duplicate-shaped body) is a genuine failure. Pure so the branch is unit-tested without fetch.
 */
export function isDuplicateInvitation(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const errors = (body as { errors?: { code?: string }[] } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e.code === "duplicate_record");
}

async function createInvitation(email: string): Promise<Response> {
  const payload: Record<string, string> = { email_address: email };
  const r = redirectUrl(email);
  if (r) payload.redirect_url = r;
  return fetch(API, { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
}

/** Pending Clerk invitation ids for an email. `query` scopes the list to this email SERVER-SIDE
 *  (the /v1/invitations list is instance-wide, so an unscoped page would miss an off-page invite
 *  once total pending exceeds the page size — reintroducing the very bug this closes). We still
 *  exact-match client-side because `query` is a substring filter, and revoke all matches (Clerk
 *  keeps ≤1 pending per email, so this is ≤1 in practice). */
async function pendingInvitationIds(email: string): Promise<string[]> {
  const res = await fetch(`${API}?status=pending&query=${encodeURIComponent(email)}&limit=100`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(json) ? json : ((json as { data?: unknown[] } | null)?.data ?? []);
  return (list as { id?: string; email_address?: string }[])
    .filter((i) => i.email_address?.toLowerCase() === email.toLowerCase() && i.id)
    .map((i) => i.id!);
}

async function revokeInvitation(id: string): Promise<void> {
  await fetch(`${API}/${id}/revoke`, { method: "POST", headers: authHeaders() });
}

/** Best-effort: revoke every pending invitation for an email (removal cleanup). Never throws —
 *  a failed revoke must not block the membership removal it accompanies. */
export async function revokeInvitationsFor(email: string): Promise<void> {
  try {
    for (const id of await pendingInvitationIds(email)) await revokeInvitation(id);
  } catch {
    /* best-effort */
  }
}

/** Send a fresh invitation email, recreating over a stale pending one. Throws on genuine failure
 *  (so the caller compensates). */
export async function sendFreshInvitation(email: string): Promise<void> {
  const res = await createInvitation(email);
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  if (!isDuplicateInvitation(res.status, body)) throw new Error(`clerk invitations.create ${res.status}`);
  // A pending invite already exists — revoke it and recreate so a NEW email actually goes out.
  await revokeInvitationsFor(email);
  const retry = await createInvitation(email);
  if (!retry.ok) throw new Error(`clerk invitations.recreate ${retry.status}`);
}
