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
import { topupShares } from './calc.js';

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
        if (file === '004_prepaid_utilities.sql') {
          for (const acc of (await client.query('SELECT * FROM prepaid_accounts')).rows) {
            const users = (await client.query('SELECT * FROM users WHERE household_id=$1 ORDER BY created_at', [acc.household_id])).rows;
            const allocations = (await client.query('SELECT * FROM prepaid_allocations WHERE prepaid_account_id=$1', [acc.id])).rows;
            const freeze = t => t.prepaid_account_id !== acc.id ? t : ({...t, shares: t.shares || topupShares(Number(t.amount), users, acc.allocation_method, allocations)});
            for (const t of (await client.query('SELECT * FROM prepaid_topups WHERE prepaid_account_id=$1', [acc.id])).rows)
              await client.query('UPDATE prepaid_topups SET shares=$1 WHERE id=$2', [JSON.stringify(freeze(t).shares), t.id]);
            for (const a of (await client.query("SELECT * FROM activity_log WHERE household_id=$1 AND entity_type='prepaid_topup'", [acc.household_id])).rows) {
              await client.query('UPDATE activity_log SET before_data=$1,after_data=$2 WHERE id=$3',
                [a.before_data ? JSON.stringify(freeze(a.before_data)) : null, a.after_data ? JSON.stringify(freeze(a.after_data)) : null, a.id]);
            }
          }
        }
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
