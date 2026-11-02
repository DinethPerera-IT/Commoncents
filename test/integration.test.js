// Integration tests: the real app against a real, throwaway Postgres.
// Needs TEST_DATABASE_URL, and the database name must contain "test": every run wipes it.
//   test/run-integration.sh   starts a disposable Postgres in Docker and runs these.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ ? 'TEST_DATABASE_URL not set (run test/run-integration.sh)' : false;
if (URL_ && !/test/.test(new URL(URL_).pathname)) throw new Error('refusing to wipe a database whose name lacks "test"');

const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname;
const PASSWORD = 'integration-test-pw';
let db, app, server, base, migrate, pool, seed;

async function resetSchema() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const quiet = () => {};

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = URL_;
  process.env.DEFAULT_PASSWORD = PASSWORD;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  db = new pg.Client({ connectionString: URL_ });
  await db.connect();
  await resetSchema();
  ({ migrate } = await import('../server/migrate.js'));
  ({ default: pool } = await import('../server/db.js'));
  seed = await import('../server/seed.js');
  ({ app } = await import('../server/index.js'));
});

after(async () => {
  if (skip) return;
  server?.close();
  await pool?.end();
  await db?.end();
});

// ---- migrations --------------------------------------------------------------------------
test('migrations: a fresh database gets every file, in order', { skip }, async () => {
  await resetSchema();
  await migrate({ log: quiet });
  const versions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  assert.deepEqual(versions, fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort());
  const d = await one("SELECT column_default FROM information_schema.columns WHERE table_name='rent_records' AND column_name='is_demo'");
  assert.equal(d.column_default, 'false');   // 002 ran
  await migrate({ log: quiet });             // a second run changes nothing
  assert.equal((await one('SELECT count(*)::int AS n FROM schema_migrations')).n, versions.length);
});

test('migrations: an existing database (tables, no history) is baselined, not re-created', { skip }, async () => {
  await resetSchema();
  await db.query(fs.readFileSync(path.join(MIGRATIONS, '001_baseline.sql'), 'utf8'));   // like live before this system
  const logs = [];
  await migrate({ log: (m) => logs.push(m) });
  assert.match(logs[0], /recorded 001_baseline\.sql as already applied/);
  assert.ok(logs.some((m) => /applied 002_/.test(m)));
});

test('migrations: a failing file is rolled back completely and not recorded', { skip }, async () => {
  await resetSchema();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, '999_broken.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
  await assert.rejects(migrate({ dir, log: quiet }), /999_broken\.sql failed and was rolled back/);
  assert.equal((await one("SELECT to_regclass('public.half_done') AS t")).t, null);
  assert.equal((await one("SELECT count(*)::int AS n FROM schema_migrations WHERE version='999_broken.sql'")).n, 0);
});

// ---- the API, on a freshly seeded database ------------------------------------------------
let cookie, members;
async function api(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, res };
}
const id = (name) => members.find((m) => m.name === name).id;

test('startup on an empty database: migrate, seed, login', { skip }, async () => {
  await resetSchema();
  await seed.migrateAndSeed();
  await seed.materialise();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await api('GET', '/healthz')).status, 200);
  const login = await api('POST', '/api/auth/login', { name: 'Dominic', password: PASSWORD });
  assert.equal(login.status, 200);
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  members = (await api('GET', '/api/members')).body;
  assert.equal(members.length, 4);
});

test('README bug 1: editing an expense without sending a date keeps its date', { skip }, async () => {
  const e = await one('SELECT id, expense_date::text AS d FROM expenses LIMIT 1');
  const r = await api('PATCH', '/api/expenses/' + e.id, { notes: 'edited without a date' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one('SELECT expense_date::text AS d FROM expenses WHERE id=$1', [e.id])).d, e.d);
});

test('README bug 2: pay a bill → undo, and pay → unpay, both leave no expense behind', { skip }, async () => {
  const bill = await one("SELECT id FROM bills WHERE status='pending' LIMIT 1");
  const paid = await api('POST', `/api/bills/${bill.id}/pay`, {});
  assert.equal(paid.status, 200);
  const exp = (await one('SELECT expense_id FROM bills WHERE id=$1', [bill.id])).expense_id;
  assert.ok(exp);
  assert.equal((await api('POST', `/api/activity/${paid.body.activity_id}/undo`)).status, 200);
  assert.deepEqual(await one('SELECT status, expense_id FROM bills WHERE id=$1', [bill.id]), { status: 'pending', expense_id: null });
  assert.equal((await one('SELECT count(*)::int AS n FROM expenses WHERE id=$1', [exp])).n, 0);

  assert.equal((await api('POST', `/api/bills/${bill.id}/pay`, {})).status, 200);
  assert.equal((await api('POST', `/api/bills/${bill.id}/unpay`)).status, 200);
  assert.deepEqual(await one('SELECT status, expense_id FROM bills WHERE id=$1', [bill.id]), { status: 'pending', expense_id: null });
});

test('percent split through the API adds up to the amount exactly', { skip }, async () => {
  const r = await api('POST', '/api/expenses', {
    description: 'Percent test', amount: 10, expense_date: '2026-11-02', category: 'Groceries',
    paid_by: id('Dineth'), split_method: 'percent',
    splits: [{ user_id: id('Dineth'), share_percent: 33.33 }, { user_id: id('Dominic'), share_percent: 33.33 },
      { user_id: id('Yesith'), share_percent: 33.34 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one('SELECT sum(share_amount)::text AS s FROM expense_splits WHERE expense_id=$1', [r.body.id])).s, '10.00');
});

test('a week URL from an old app version (Saturday) is read as the following Monday', { skip }, async () => {
  const r = await api('GET', '/api/weeks/2026-10-24/summary');
  assert.equal(r.status, 200);
  assert.equal(r.body.week_start, '2026-10-26');
});

test('reset-demo: removes demo payments, frees real bills that pointed at them, keeps real data', { skip }, async () => {
  const hh = (await one('SELECT id FROM households')).id;
  const cat = (await one('SELECT id FROM categories LIMIT 1')).id;
  const real = await api('POST', '/api/expenses', {
    description: 'Real groceries', amount: 42, expense_date: '2026-11-02', category: 'Groceries', paid_by: id('Yesith'),
  });
  assert.equal(real.status, 200);
  // A: a demo bill paid through the API (its expense is created with is_demo = false)
  const demoBill = await one(`INSERT INTO bills (household_id, category_id, name, amount, due_date, is_demo)
                              VALUES ($1,$2,'Demo bill',40,'2026-11-05',true) RETURNING id`, [hh, cat]);
  assert.equal((await api('POST', `/api/bills/${demoBill.id}/pay`, {})).status, 200);
  const demoPayment = (await one('SELECT expense_id FROM bills WHERE id=$1', [demoBill.id])).expense_id;
  // B: a real bill whose payment is a demo expense (the bills_expense_id_fkey case)
  const demoExp = await one(`SELECT id FROM expenses WHERE is_demo LIMIT 1`);
  const realBill = await one(`INSERT INTO bills (household_id, category_id, name, amount, due_date, status, paid_by, expense_id)
                              VALUES ($1,$2,'Real bill',25,'2026-11-05','paid',$3,$4) RETURNING id`, [hh, cat, id('Dominic'), demoExp.id]);

  const r = await api('POST', '/api/admin/reset-demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await one('SELECT count(*)::int AS n FROM expenses WHERE is_demo OR id=$1', [demoPayment])).n, 0);
  assert.deepEqual(await one('SELECT status, expense_id FROM bills WHERE id=$1', [realBill.id]), { status: 'pending', expense_id: null });
  assert.equal((await one('SELECT count(*)::int AS n FROM expenses WHERE id=$1', [real.body.id])).n, 1);
  for (const t of ['bills', 'settlements', 'prepaid_topups', 'prepaid_usage', 'rent_records']) {
    assert.equal((await one(`SELECT count(*)::int AS n FROM ${t} WHERE is_demo`)).n, 0, t);
  }
});

test('database errors are not sent to the browser', { skip }, async () => {
  const r = await api('PATCH', '/api/bills/not-a-uuid', { amount: 5 });
  assert.equal(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.body), /uuid|syntax|SELECT/i);
});

test('login rate limit: the 11th failed attempt from one client is refused', { skip }, async () => {
  const saved = cookie; cookie = null;
  const attempt = (ip) => api('POST', '/api/auth/login', { name: 'Dominic', password: 'wrong' }, { 'X-Forwarded-For': ip });
  for (let i = 0; i < 10; i++) assert.equal((await attempt('203.0.113.5')).status, 401);
  assert.equal((await attempt('203.0.113.5')).status, 429);
  assert.equal((await attempt('203.0.113.6')).status, 401);   // someone else is unaffected
  cookie = saved;
});
