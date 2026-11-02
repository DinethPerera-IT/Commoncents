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

// ---- feature: CSV export ----------------------------------------------------------------
test('CSV export: needs login, downloads every expense with shares, neutralises formulas', { skip }, async () => {
  const saved = cookie; cookie = null;
  assert.equal((await api('GET', '/api/export/expenses.csv')).status, 401);
  cookie = saved;
  const evil = await api('POST', '/api/expenses', {
    description: '=HYPERLINK("http://example.invalid","x")', amount: 9.99, expense_date: '2026-10-15',
    category: 'Groceries', paid_by: id('Sihas'),
  });
  assert.equal(evil.status, 200);
  const r = await fetch(base + '/api/export/expenses.csv', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="commoncents-expenses-start_to_\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // UTF-8 BOM, for Excel
  const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
  assert.match(lines[0], /^Date,Description,Category,Amount,Paid by,Split,Status,Shared,Notes,Dineth share,Dominic share,Yesith share,Sihas share$/);
  assert.equal(lines.length - 1, (await one('SELECT count(*)::int AS n FROM expenses')).n);
  const row = lines.find((l) => l.includes('HYPERLINK'));
  assert.ok(row.startsWith('2026-10-15,"\'=HYPERLINK('), row);
  assert.match(row, /,9\.99,Sihas,equal,pending,yes,,2\.49,2\.5,2\.5,2\.5$/);
});

test('CSV export: date range is inclusive at both ends', { skip }, async () => {
  const fromTo = async (q) => (await (await fetch(base + '/api/export/expenses.csv' + q, { headers: { Cookie: cookie } })).text())
    .trimEnd().split('\r\n').slice(1);
  const rows = await fromTo('?from=2026-10-15&to=2026-10-15');
  assert.ok(rows.length >= 1 && rows.every((l) => l.startsWith('2026-10-15,')), rows.join('\n'));
  for (const name of ['settlements', 'rent']) {
    const r = await fetch(base + `/api/export/${name}.csv?from=2026-01-01`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200, name);
  }
});

// ---- feature: category budgets ----------------------------------------------------------
test('budgets: set, show spending for the month, change, remove, and undo each step', { skip }, async () => {
  const groceries = (await one("SELECT id FROM categories WHERE name='Groceries'")).id;
  const month = '2026-10';
  const spentInOct = Number((await one(`SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE category_id=$1
                                        AND expense_date >= '2026-10-01' AND expense_date < '2026-11-01'`, [groceries])).s);
  const get = async () => (await api('GET', '/api/budgets?month=' + month)).body.budgets.find((b) => b.category_id === groceries);
  assert.equal((await get()).monthly_amount, null);

  const set = await api('PUT', '/api/budgets/' + groceries, { monthly_amount: 600 });
  assert.equal(set.status, 200);
  assert.deepEqual(await get(), { category_id: groceries, category: 'Groceries', monthly_amount: 600, spent: spentInOct });
  const change = await api('PUT', '/api/budgets/' + groceries, { monthly_amount: 450.5 });
  assert.equal((await get()).monthly_amount, 450.5);
  const remove = await api('PUT', '/api/budgets/' + groceries, { monthly_amount: null });
  assert.equal((await get()).monthly_amount, null);

  assert.equal((await api('POST', `/api/activity/${remove.body.activity_id}/undo`)).status, 200);
  assert.equal((await get()).monthly_amount, 450.5);
  assert.equal((await api('POST', `/api/activity/${change.body.activity_id}/undo`)).status, 200);
  assert.equal((await get()).monthly_amount, 600);
  assert.equal((await api('POST', `/api/activity/${set.body.activity_id}/undo`)).status, 200);
  assert.equal((await get()).monthly_amount, null);
});

test('budgets: validation, unknown category, and admin only', { skip }, async () => {
  const cat = (await one('SELECT id FROM categories LIMIT 1')).id;
  assert.equal((await api('PUT', '/api/budgets/' + cat, { monthly_amount: -5 })).status, 400);
  assert.equal((await api('PUT', '/api/budgets/not-a-uuid', { monthly_amount: 5 })).status, 404);
  const saved = cookie;
  const login = await api('POST', '/api/auth/login', { name: 'Yesith', password: PASSWORD });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('PUT', '/api/budgets/' + cat, { monthly_amount: 50 })).status, 403);
  assert.equal((await api('GET', '/api/budgets')).status, 200);   // everyone can look
  cookie = saved;
});

// ---- feature: reports --------------------------------------------------------------------
test('reports: monthly trend ends with this month and matches the expenses', { skip }, async () => {
  const r = await api('GET', '/api/reports/monthly?months=3');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 3);
  const { today } = await import('../server/calc.js');
  assert.equal(r.body[2].month, today().slice(0, 7));
  for (const m of r.body) {
    const want = Number((await one("SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE to_char(expense_date,'YYYY-MM')=$1", [m.month])).s);
    assert.equal(m.total, want, m.month);
  }
});

test('reports: by-member honours the period (from inclusive, to exclusive)', { skip }, async () => {
  const r = await api('GET', '/api/reports/by-member?from=2026-10-15&to=2026-10-16');
  const want = await db.query(`SELECT u.name, COALESCE(SUM(e.amount),0)::float AS t FROM users u LEFT JOIN expenses e
                               ON e.paid_by=u.id AND e.expense_date='2026-10-15' GROUP BY u.name`);
  for (const row of want.rows) assert.equal(Number(r.body.find((m) => m.name === row.name).total), row.t, row.name);
  assert.ok(Number(r.body.find((m) => m.name === 'Sihas').total) >= 9.99);   // the CSV test's expense
});

// ---- feature: recurring bills admin ------------------------------------------------------
test('recurring bills: create (monthly → this month’s bill appears), edit, stop, undo each', { skip }, async () => {
  const { today } = await import('../server/calc.js');
  const month = today().slice(0, 7);
  const created = await api('POST', '/api/recurring-bills', {
    name: 'Gas', category: 'Miscellaneous', frequency: 'monthly', expected_amount: 55.5, due_day: 20, default_payer: id('Sihas'),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.due_rule, 'DAY:20');
  const bill = await one('SELECT name, amount::text, due_date::text, status FROM bills WHERE id=$1', [created.body.generated_bill_id]);
  assert.deepEqual(bill, { name: 'Gas', amount: '55.50', due_date: month + '-20', status: 'pending' });
  assert.ok((await api('GET', '/api/recurring-bills')).body.some((r) => r.id === created.body.id));

  const edited = await api('PATCH', '/api/recurring-bills/' + created.body.id, { expected_amount: 60, due_day: 5 });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.expected_amount, edited.body.due_rule, edited.body.name], ['60.00', 'DAY:5', 'Gas']);
  assert.equal((await one('SELECT amount::text AS a FROM bills WHERE id=$1', [created.body.generated_bill_id])).a, '55.50');   // existing bill untouched

  const stopped = await api('DELETE', '/api/recurring-bills/' + created.body.id);
  assert.equal(stopped.status, 200);
  assert.ok(!(await api('GET', '/api/recurring-bills')).body.some((r) => r.id === created.body.id));

  assert.equal((await api('POST', `/api/activity/${stopped.body.activity_id}/undo`)).status, 200);
  assert.ok((await api('GET', '/api/recurring-bills')).body.some((r) => r.id === created.body.id));
  assert.equal((await api('POST', `/api/activity/${edited.body.activity_id}/undo`)).status, 200);
  assert.equal((await one('SELECT expected_amount::text AS a, due_rule FROM recurring_bills WHERE id=$1', [created.body.id])).a, '55.50');
  assert.equal((await api('POST', `/api/activity/${created.body.activity_id}/undo`)).status, 200);
  assert.equal((await one('SELECT count(*)::int AS n FROM recurring_bills WHERE id=$1', [created.body.id])).n, 0);
  assert.equal((await one('SELECT count(*)::int AS n FROM bills WHERE id=$1', [created.body.generated_bill_id])).n, 0);
});

test('recurring bills: undoing a create keeps a bill someone already paid', { skip }, async () => {
  const created = await api('POST', '/api/recurring-bills', { name: 'Bins', category: 'Miscellaneous', frequency: 'monthly', expected_amount: 12 });
  assert.equal((await api('POST', `/api/bills/${created.body.generated_bill_id}/pay`, {})).status, 200);
  assert.equal((await api('POST', `/api/activity/${created.body.activity_id}/undo`)).status, 200);
  assert.equal((await one('SELECT status FROM bills WHERE id=$1', [created.body.generated_bill_id])).status, 'paid');
  assert.equal((await one('SELECT active FROM recurring_bills WHERE id=$1', [created.body.id])).active, false);
});

test('recurring bills: validation and admin only', { skip }, async () => {
  const bad = (body) => api('POST', '/api/recurring-bills', { name: 'X', category: 'Water', frequency: 'monthly', expected_amount: 1, ...body });
  assert.equal((await bad({ due_day: 31 })).status, 400);
  assert.equal((await bad({ frequency: 'yearly' })).status, 400);
  assert.equal((await bad({ category: 'Nope' })).status, 400);
  assert.equal((await bad({ name: '  ' })).status, 400);
  assert.equal((await bad({ expected_amount: -1 })).status, 400);
  const weekly = await bad({ frequency: 'weekly', name: 'Cleaner' });
  assert.equal(weekly.status, 200);
  assert.equal(weekly.body.generated_bill_id, null);   // weekly entries are reminders only
  const saved = cookie;
  const login = await api('POST', '/api/auth/login', { name: 'Yesith', password: PASSWORD });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await bad({})).status, 403);
  assert.equal((await api('DELETE', '/api/recurring-bills/' + weekly.body.id)).status, 403);
  cookie = saved;
});

// ---- feature: statements -----------------------------------------------------------------
test('statement: for every member, the all-time statement ends at their balance', { skip }, async () => {
  const bal = (await api('GET', '/api/balances')).body.net;
  for (const m of members) {
    const st = await api('GET', '/api/statement?member=' + m.id);
    assert.equal(st.status, 200);
    assert.equal(Math.round(st.body.closing * 100), Math.round(bal[m.id] * 100), m.name);
  }
  const mine = await api('GET', '/api/statement');
  assert.equal(mine.body.member.name, 'Dominic');   // default: whoever is logged in
});

test('statement: a period starts from the opening balance and only lists its own dates', { skip }, async () => {
  const st = (await api('GET', `/api/statement?member=${id('Sihas')}&from=2026-10-15&to=2026-10-15`)).body;
  assert.ok(st.entries.length >= 1);
  assert.ok(st.entries.every((e) => e.date === '2026-10-15'));
  const sum = st.entries.reduce((s, e) => s + Math.round(e.amount * 100), 0);
  assert.equal(Math.round(st.closing * 100), Math.round(st.opening * 100) + sum);
  assert.equal((await api('GET', '/api/statement?member=not-a-uuid')).status, 404);
});

// Combined utilities: production endpoints, disposable database only.
test('utilities: top-ups count once, usage changes credit only, immutable shares and undo', {skip}, async()=>{
  assert.equal((await api('POST','/api/recurring-bills',{name:'Electricity',category:'Electricity',frequency:'monthly',expected_amount:50})).status,400);
  const before=(await api('GET','/api/balances')).body.net;
  const oldCredit=(await api('GET','/api/prepaid')).body.balance;
  const month=(await import('../server/calc.js')).today().slice(0,7);
  const reportBefore=(await api('GET','/api/reports/monthly?months=1')).body[0].total;
  const topup=await api('POST','/api/prepaid/topups',{amount:100,paid_by:id('Dominic'),topup_date:month+'-03'});
  assert.equal(topup.status,200,JSON.stringify(topup.body));
  const after=(await api('GET','/api/balances')).body.net;
  for(const m of members) assert.equal(Math.round((after[m.id]-before[m.id])*100),m.name==='Dominic'?7500:-2500);
  const usage=await api('POST','/api/prepaid/usage',{amount:30,usage_date:month+'-03',note:'Meter reading'});
  assert.equal(usage.status,200);
  assert.equal((await api('GET','/api/prepaid')).body.balance,oldCredit+70);
  assert.deepEqual((await api('GET','/api/balances')).body.net,after);
  assert.equal((await api('GET','/api/reports/monthly?months=1')).body[0].total,reportBefore+100);
  assert.equal((await api('PUT','/api/prepaid/allocation',{method:'equal'})).status,400);
  assert.equal((await api('POST','/api/prepaid/topups',{amount:1,paid_by:'not-a-member'})).status,400);
  assert.equal((await api('POST','/api/prepaid/usage',{amount:100000})).status,400);
  assert.equal((await api('POST','/api/prepaid/usage',{amount:1,usage_date:'2026-02-30'})).status,400);
  const percent=await api('POST','/api/prepaid/topups',{amount:0.01,method:'percent',allocations:members.map(m=>({user_id:m.id,percent:25}))});
  assert.equal(percent.status,200);
  const snap=await one('SELECT shares FROM prepaid_topups WHERE id=$1',[percent.body.id]);
  assert.equal(Object.values(snap.shares).reduce((s,n)=>s+Math.round(n*100),0),1);
  const edited=await api('PATCH','/api/prepaid/topups/'+percent.body.id,{amount:20,method:'custom',allocations:members.map(m=>({user_id:m.id,fixed_amount:5}))});
  assert.equal(edited.status,200,JSON.stringify(edited.body));
  assert.equal((await api('POST','/api/activity/'+edited.body.activity_id+'/undo')).status,200);
  assert.deepEqual((await one('SELECT shares FROM prepaid_topups WHERE id=$1',[percent.body.id])).shares,snap.shares);
  const deleted=await api('DELETE','/api/prepaid/topups/'+percent.body.id);
  assert.equal(deleted.status,200);
  assert.equal((await api('POST','/api/activity/'+deleted.body.activity_id+'/undo')).status,200);
  assert.deepEqual((await one('SELECT shares FROM prepaid_topups WHERE id=$1',[percent.body.id])).shares,snap.shares);
  const whole=(await api('GET','/api/prepaid')).body;
  const spendAll=await api('POST','/api/prepaid/usage',{amount:whole.balance,usage_date:month+'-03'});
  assert.equal(spendAll.status,200);
  const removal=await api('DELETE','/api/prepaid/topups/'+topup.body.id);
  assert.equal(removal.status,400);
  assert.equal((await one('SELECT amount FROM prepaid_topups WHERE id=$1',[topup.body.id])).amount,'100.00');
  assert.equal((await api('POST','/api/activity/'+spendAll.body.activity_id+'/undo')).status,200);
  for(const m of members){const statement=(await api('GET','/api/statement?member='+m.id)).body;const balances=(await api('GET','/api/balances')).body.net;assert.equal(Math.round(statement.closing*100),Math.round(balances[m.id]*100));}
  assert.equal((await api('GET','/api/export/spending.csv')).status,200);
});

test('utilities migration: freezes legacy shares, keeps IDs/credit/budget collisions/bills, retires only electricity', {skip}, async()=>{
  await resetSchema();
  for(const name of ['001_baseline.sql','002_rent_is_demo_default_false.sql','003_category_budgets.sql']) await db.query(fs.readFileSync(path.join(MIGRATIONS,name),'utf8'));
  await db.query('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ DEFAULT now())');
  for(const name of ['001_baseline.sql','002_rent_is_demo_default_false.sql','003_category_budgets.sql'])await db.query('INSERT INTO schema_migrations(version)VALUES($1)',[name]);
  const hh=(await one("INSERT INTO households(name) VALUES('Migration test') RETURNING id")).id;
  const us=[];for(let i=0;i<4;i++) us.push((await one("INSERT INTO users(household_id,name,initials,weekly_rent) VALUES($1,$2,'MT',200) RETURNING id",[hh,'M'+i])).id);
  const cats=[];for(const n of ['Fibre / Broadband','Electricity','Water'])cats.push((await one('INSERT INTO categories(household_id,name)VALUES($1,$2) RETURNING id',[hh,n])).id);
  for(const c of cats.slice(0,2))await db.query('INSERT INTO category_budgets(category_id,household_id,monthly_amount)VALUES($1,$2,100)',[c,hh]);
  const acc=(await one("INSERT INTO prepaid_accounts(household_id,name)VALUES($1,'Fibre / Broadband')RETURNING id",[hh])).id;
  const t=(await one("INSERT INTO prepaid_topups(prepaid_account_id,amount,paid_by,topup_date)VALUES($1,100,$2,'2026-11-01')RETURNING id",[acc,us[0]])).id;
  await db.query("INSERT INTO prepaid_usage(prepaid_account_id,amount,usage_date)VALUES($1,30,'2026-11-02')",[acc]);
  for(const c of cats.slice(1))await db.query("INSERT INTO recurring_bills(household_id,category_id,name,frequency,expected_amount)VALUES($1,$2,'Legacy','monthly',20)",[hh,c]);
  const bill=(await one("INSERT INTO bills(household_id,category_id,name,amount,due_date)VALUES($1,$2,'Legacy electricity',20,'2026-11-12')RETURNING id",[hh,cats[1]])).id;
  await migrate({log:quiet});await migrate({log:quiet});
  assert.equal((await one('SELECT amount FROM prepaid_topups WHERE id=$1',[t])).amount,'100.00');
  assert.deepEqual((await one('SELECT shares FROM prepaid_topups WHERE id=$1',[t])).shares,Object.fromEntries(us.map(id=>[id,25])));
  assert.equal((await one('SELECT status FROM bills WHERE id=$1',[bill])).status,'pending');
  assert.equal((await one('SELECT count(*)::int n FROM category_budgets')).n,2);
  assert.equal((await one('SELECT active FROM recurring_bills WHERE category_id=$1',[cats[1]])).active,false);
  assert.equal((await one('SELECT active FROM recurring_bills WHERE category_id=$1',[cats[2]])).active,true);
  assert.equal((await one('SELECT SUM(amount)::float n FROM prepaid_usage')).n,30);
});
