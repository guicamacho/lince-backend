/** Single pg Pool for the process. Primary Postgres lives in São Paulo (gru) in prod. */
import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

/** Run fn inside a transaction; rolls back on throw.
 *
 * PRD-07 §7 contention timeouts ride each transaction as SET LOCAL (they expire with the
 * tx). Deliberately NOT pool-wide startup options: the deployed DB's connection pooler
 * rejects the libpq `options` startup parameter ("unsupported startup parameter"), and
 * scoping to transactions keeps db/migrate.ts (its own begin/commit, long DDL allowed)
 * and non-transactional reads untimed. SERIALIZABLE deliberately not used (PRD §7). */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin; set local lock_timeout = '3s'; set local statement_timeout = '10s'");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
