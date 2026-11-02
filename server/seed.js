// Startup: bring the schema up to date, then seed a default household if the database is empty.
import bcrypt from 'bcryptjs';
import { q, one, all } from './db.js';
import { migrate } from './migrate.js';
import { weekStartOf, addDays, today, equalSplit, round2 } from './calc.js';

export async function migrateAndSeed() {
  await migrate();   // schema changes live in migrations/*.sql (see server/migrate.js)

  const hh = await one('SELECT id FROM households LIMIT 1');
  if (hh) return;
  console.log('[seed] seeding default household…');

  const household = await one(
    "INSERT INTO households (name) VALUES ('CommonCents Household') RETURNING id");
  const hid = household.id;

  const defaultPw = process.env.DEFAULT_PASSWORD || 'commoncents';
  const hash = await bcrypt.hash(defaultPw, 10);
  const memberDefs = [
    ['Dineth', 'DN', 200], ['Dominic', 'DM', 220], ['Yesith', 'YS', 170], ['Sihas', 'SH', 200],
  ];
  const users = [];
  for (const [name, initials, rent] of memberDefs) {
    users.push(await one(
      `INSERT INTO users (household_id, name, initials, email, password_hash, weekly_rent, is_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, weekly_rent`,
      [hid, name, initials, name.toLowerCase() + '@commoncents.local', hash, rent, name === 'Dominic']));
  }
  const uid = (n) => users.find((u) => u.name === n).id;

  const catNames = ['Rent','Groceries','Fibre / Broadband','Mobile Plans','Water','Electricity','Cleaning Supplies','Electrical Appliances','Miscellaneous'];
  const cats = {};
  for (let i = 0; i < catNames.length; i++) {
    const c = await one('INSERT INTO categories (household_id, name, sort) VALUES ($1,$2,$3) RETURNING id, name', [hid, catNames[i], i]);
    cats[c.name] = c.id;
  }

  // 9 weeks: 8 history + current
  const cw = weekStartOf(today());
  const weeks = Array.from({ length: 9 }, (_, i) => addDays(cw, (i - 8) * 7));

  // Rent records (history mostly paid; current week mixed) — demo data
  for (let i = 0; i < weeks.length; i++) {
    for (const u of users) {
      let paid = Number(u.weekly_rent), status = 'paid';
      if (i === 5 && u.name === 'Sihas') { paid = 100; status = 'partial'; }
      if (i === 6 && u.name === 'Sihas') { paid = 300; }
      if (i === 8) {
        if (u.name === 'Yesith') { paid = 100; status = 'partial'; }
        if (u.name === 'Sihas') { paid = 0; status = 'unpaid'; }
      }
      await q(`INSERT INTO rent_records (household_id, user_id, week_start, amount_due, amount_paid, status, is_demo)
               VALUES ($1,$2,$3,$4,$5,$6,true)`, [hid, u.id, weeks[i], u.weekly_rent, paid, status]);
    }
  }

  const allIds = users.map((u) => u.id);
  async function addExpense(date, cat, desc, amount, paidBy, opts = {}) {
    const e = await one(
      `INSERT INTO expenses (household_id, category_id, description, amount, expense_date, paid_by, split_method, status, notes, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id`,
      [hid, cats[cat], desc, amount, date, paidBy, opts.method || 'equal', opts.status || 'settled', opts.notes || null]);
    const shares = opts.shares || equalSplit(amount, allIds);
    for (const [userId, share] of Object.entries(shares)) {
      await q('INSERT INTO expense_splits (expense_id, user_id, share_amount) VALUES ($1,$2,$3)', [e.id, userId, share]);
    }
  }
  const W = weeks;
  await addExpense(addDays(W[0],1),'Groceries','Pak’nSave weekly shop',182.40,uid('Dominic'));
  await addExpense(addDays(W[0],4),'Cleaning Supplies','Dish liquid, sponges, sprays',34.50,uid('Yesith'));
  await addExpense(addDays(W[1],1),'Groceries','Countdown shop',164.90,uid('Dineth'));
  await addExpense(addDays(W[1],3),'Electricity','Contact Energy — month 1',138.20,uid('Sihas'));
  await addExpense(addDays(W[1],5),'Groceries','Veggie market run',46.80,uid('Yesith'));
  await addExpense(addDays(W[2],0),'Mobile Plans','Shared Skinny plan',68.00,uid('Dominic'));
  await addExpense(addDays(W[2],2),'Groceries','Pak’nSave weekly shop',175.15,uid('Dominic'));
  await addExpense(addDays(W[2],5),'Miscellaneous','Lightbulbs + batteries',22.90,uid('Dineth'));
  await addExpense(addDays(W[3],1),'Groceries','Countdown shop',158.60,uid('Sihas'));
  await addExpense(addDays(W[3],4),'Water','Watercare — month 1',79.40,uid('Dominic'));
  await addExpense(addDays(W[4],1),'Groceries','Pak’nSave weekly shop',190.25,uid('Yesith'));
  await addExpense(addDays(W[4],3),'Electrical Appliances','Replacement kettle',89.00,uid('Dineth'),
    { method:'custom', shares: { [uid('Dineth')]:29, [uid('Dominic')]:20, [uid('Yesith')]:20, [uid('Sihas')]:20 }, notes:'Dineth chipped in extra' });
  await addExpense(addDays(W[5],2),'Groceries','Countdown shop',171.30,uid('Dominic'));
  await addExpense(addDays(W[5],5),'Cleaning Supplies','Vacuum bags, bin liners',28.75,uid('Sihas'));
  await addExpense(addDays(W[6],0),'Mobile Plans','Shared Skinny plan',68.00,uid('Dominic'));
  await addExpense(addDays(W[6],2),'Groceries','Pak’nSave weekly shop',168.45,uid('Dineth'));
  await addExpense(addDays(W[6],4),'Electricity','Contact Energy — month 2',145.60,uid('Sihas'),
    { method:'percent', shares: { [uid('Dineth')]:36.40, [uid('Dominic')]:43.68, [uid('Yesith')]:29.12, [uid('Sihas')]:36.40 }, notes:'25/30/20/25 split' });
  await addExpense(addDays(W[7],1),'Groceries','Countdown shop',176.80,uid('Yesith'));
  await addExpense(addDays(W[7],3),'Water','Watercare — month 2',82.10,uid('Dominic'),{status:'pending'});
  await addExpense(addDays(W[7],5),'Miscellaneous','Shared Netflix + power board',31.50,uid('Dineth'),{status:'pending'});
  await addExpense(addDays(W[8],1),'Groceries','Pak’nSave weekly shop',187.90,uid('Dominic'),{status:'pending'});
  await addExpense(addDays(W[8],3),'Cleaning Supplies','Laundry powder, surface spray',26.40,uid('Yesith'),{status:'pending'});

  // Recurring bills
  const rec = [
    ['Rent', 'Rent', 'weekly', 790, 'MON', null, 'per-person rent'],
    ['Fibre top-up', 'Fibre / Broadband', 'prepaid', 250, 'ON_DEPLETION', uid('Dominic'), 'equal'],
    ['Mobile plan', 'Mobile Plans', 'monthly', 68, 'DAY:7', uid('Dominic'), 'equal'],
    ['Electricity', 'Electricity', 'monthly', 145, 'DAY:12', uid('Sihas'), 'equal'],
    ['Water', 'Water', 'monthly', 82, 'DAY:18', uid('Dominic'), 'equal'],
  ];
  for (const [name, cat, freq, amt, rule, payer, split] of rec) {
    await q(`INSERT INTO recurring_bills (household_id, category_id, name, frequency, expected_amount, due_rule, default_payer, default_split)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [hid, cats[cat], name, freq, amt, rule, payer, split]);
  }

  // Upcoming bills — demo
  const t = today();
  await q(`INSERT INTO bills (household_id, category_id, name, amount, due_date, billing_period, status, is_demo)
           VALUES ($1,$2,'Mobile — Skinny shared plan',68.00,$3,'current','pending',true)`, [hid, cats['Mobile Plans'], addDays(t, 3)]);
  await q(`INSERT INTO bills (household_id, category_id, name, amount, due_date, billing_period, status, is_demo)
           VALUES ($1,$2,'Electricity — Contact Energy',149.00,$3,'current','pending',true)`, [hid, cats['Electricity'], addDays(t, 8)]);
  await q(`INSERT INTO bills (household_id, category_id, name, amount, due_date, billing_period, status, is_demo)
           VALUES ($1,$2,'Water — Watercare',84.00,$3,'current','pending',true)`, [hid, cats['Water'], addDays(t, 14)]);

  // Prepaid fibre: $250 top-up 8 weeks ago + weekly usage
  const pa = await one(`INSERT INTO prepaid_accounts (household_id, name) VALUES ($1,'Fibre / Broadband') RETURNING id`, [hid]);
  await q(`INSERT INTO prepaid_topups (prepaid_account_id, amount, paid_by, topup_date, is_demo) VALUES ($1,250,$2,$3,true)`, [pa.id, uid('Dominic'), W[0]]);
  const usageAmts = [13.2,12.8,14.1,13.5,12.9,13.8,13.1,13.6];
  for (let i = 0; i < 8; i++) {
    await q(`INSERT INTO prepaid_usage (prepaid_account_id, amount, usage_date, note, is_demo) VALUES ($1,$2,$3,'Weekly usage',true)`, [pa.id, usageAmts[i], addDays(W[i], 6)]);
  }

  // Historic settlements — demo
  const st = [
    [addDays(W[2],6), uid('Dineth'), uid('Dominic'), 84.20, 'bank_transfer', 'Weeks 1–3 square-up'],
    [addDays(W[2],6), uid('Yesith'), uid('Dominic'), 71.50, 'bank_transfer', 'Weeks 1–3 square-up'],
    [addDays(W[5],6), uid('Sihas'), uid('Yesith'), 55.00, 'cash', ''],
    [addDays(W[5],6), uid('Dominic'), uid('Dineth'), 12.40, 'bank_transfer', ''],
  ];
  for (const [date, payer, recipient, amount, method, notes] of st) {
    await q(`INSERT INTO settlements (household_id, payer, recipient, amount, settled_on, method, notes, is_demo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true)`, [hid, payer, recipient, amount, date, method, notes]);
  }
  console.log('[seed] done. Default login password: ' + defaultPw);
}

// Housekeeping: ensure rent rows exist for the current week; materialise monthly bills.
export async function materialise() {
  const hh = await one('SELECT id FROM households LIMIT 1');
  if (!hh) return;
  const cw = weekStartOf(today());
  const users = await all('SELECT id, weekly_rent FROM users WHERE household_id=$1 AND active', [hh.id]);
  for (const u of users) {
    await q(`INSERT INTO rent_records (household_id, user_id, week_start, amount_due, amount_paid, status, is_demo)
             VALUES ($1,$2,$3,$4,0,'unpaid',false) ON CONFLICT (user_id, week_start) DO NOTHING`,
      [hh.id, u.id, cw, u.weekly_rent]);
  }
  // Monthly recurring → ensure one pending bill this month
  const month = today().slice(0, 7);
  const recs = await all(`SELECT * FROM recurring_bills WHERE household_id=$1 AND active AND frequency='monthly'`, [hh.id]);
  for (const r of recs) {
    const existing = await one(
      `SELECT id FROM bills WHERE recurring_bill_id=$1 AND to_char(due_date,'YYYY-MM')=$2`, [r.id, month]);
    if (existing) continue;
    const day = String(r.due_rule || '').startsWith('DAY:') ? parseInt(r.due_rule.slice(4)) : 15;
    const due = month + '-' + String(Math.min(day, 28)).padStart(2, '0');
    await q(`INSERT INTO bills (household_id, recurring_bill_id, category_id, name, amount, due_date, billing_period, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [hh.id, r.id, r.category_id, r.name, r.expected_amount || 0, due, month]);
  }
  // Expired logins are never valid again (requireAuth checks expires_at); drop them so the table doesn't grow forever.
  const gone = await q('DELETE FROM sessions WHERE expires_at < now()');
  if (gone.rowCount) console.log('[materialise] removed ' + gone.rowCount + ' expired sessions');
}
