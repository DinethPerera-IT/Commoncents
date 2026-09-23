import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0];
export const all = async (text, params) => (await pool.query(text, params)).rows;
export default pool;
