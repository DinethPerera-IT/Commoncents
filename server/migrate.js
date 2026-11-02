// Database migrations: numbered .sql files in migrations/, each applied once, in order,
// inside its own transaction, and recorded in schema_migrations.
//
// - Fresh database: every file runs, starting with 001_baseline.sql.
// - The live database predates this system: it already has the tables, so 001 is recorded
//   as applied without running it ("baselining"), and only newer files run.
// - A failing file rolls back completely and stops startup; nothing half-applied is recorded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './db.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 4040;   // any fixed number: stops two app instances migrating at the same time

export async function migrate({ dir = DIR, log = console.log } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    if (!done.size && (await client.query("SELECT to_regclass('public.households') AS t")).rows[0].t) {
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [files[0]]);
      done.add(files[0]);
      log(`[migrate] existing database: recorded ${files[0]} as already applied`);
    }
    for (const file of files.filter((f) => !done.has(f))) {
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`[migrate] applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed and was rolled back: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
