/**
 * Minimal forward-only migration runner.
 * Applies db/migrations/*.sql in filename order, tracking applied files in
 * a _migrations table. No down-migrations (forward-only by design).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

async function run(): Promise<void> {
  await pool.query(
    `create table if not exists _migrations (
       filename text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rowCount } = await pool.query("select 1 from _migrations where filename = $1", [file]);
    if (rowCount) {
      console.log(`= skip ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _migrations (filename) values ($1)", [file]);
      await client.query("commit");
      console.log(`+ applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log("migrations complete");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
