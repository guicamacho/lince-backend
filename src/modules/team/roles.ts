/**
 * Team role mutations on org_people.roles (PRD-07 §2 pattern 10).
 *
 * `roles` is a text[]; a naive read-modify-write races — two concurrent adds lose one. Every
 * mutation takes the row lock (SELECT ... FOR UPDATE) first, so the read-modify-write is
 * serialised: the second writer re-reads the first's committed roles before merging. Ownership
 * transfer would demote-then-promote in one such tx (the single-owner partial index is checked
 * per statement); not wired here until its WP.
 */
import { withTransaction } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";

/** Add roles to an org_people row without losing a concurrent add. Returns the merged set. */
export async function addOrgPersonRoles(orgId: string, personId: string, roles: string[]): Promise<string[]> {
  return withTransaction(async (c) => {
    const locked = await c.query<{ roles: string[] }>(
      `select roles from org_people where org_id = $1 and person_id = $2 for update`,
      [orgId, personId],
    );
    if (!locked.rows[0]) throw new HttpError("org_person_not_found", 404);
    const next = [...new Set([...locked.rows[0].roles, ...roles])];
    const upd = await c.query<{ roles: string[] }>(
      `update org_people set roles = $3 where org_id = $1 and person_id = $2 returning roles`,
      [orgId, personId, next],
    );
    return upd.rows[0]!.roles;
  });
}
