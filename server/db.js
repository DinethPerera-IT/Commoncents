import pg from 'pg';
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
