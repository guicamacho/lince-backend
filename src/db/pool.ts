/** Single pg Pool for the process. Primary Postgres lives in São Paulo (gru) in prod. */
import pg from "pg";
import { env } from "../config/env.js";

// PRD-07 §7 session defaults (config, not DDL): fail fast on contention, retry safe.
// Set via connection startup options so every session inherits them without a
// per-connect query (pool.on("connect") + fire-and-forget query is deprecated in pg).
// SERIALIZABLE is deliberately NOT used — targeted advisory + row locks (PRD §7).
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  options: "-c lock_timeout=3s -c statement_timeout=10s",
});

/** Run fn inside a transaction; rolls back on throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
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
