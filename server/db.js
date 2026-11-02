import pg from 'pg';

// Postgres DATE columns (type id 1082) are calendar days such as 2026-09-01, with no time or
// time zone. By default pg turns them into JS Date objects at *local* midnight, and any later
// .toISOString() converts that to UTC: in New Zealand (UTC+12/13) local midnight is still the
// previous day in UTC, so every date would shift back one day. Keep them as 'YYYY-MM-DD'
// strings instead; they compare, sort and print correctly in any server time zone.
pg.types.setTypeParser(1082, (v) => v);
import { AsyncLocalStorage } from 'node:async_hooks';
const session = new AsyncLocalStorage();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params) => (session.getStore() || pool).query(text, params);
export const one = async (text, params) => (await (session.getStore() || pool).query(text, params)).rows[0];
export const all = async (text, params) => (await (session.getStore() || pool).query(text, params)).rows;

// Run fn(client) inside one transaction: all of its queries commit together, or none do.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await session.run(client, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export default pool;
