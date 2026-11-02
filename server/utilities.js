// Fibre & Electricity: one shared prepaid account for both utilities.
//
// - A top-up is real money one flatmate pays in. Its split between flatmates ("shares") is
//   worked out once, when it is recorded, and saved on the row. Later changes to who lives in
//   the flat or how future top-ups are split never rewrite past top-ups.
// - Usage only lowers the account's credit. It moves no money between flatmates, so it never
//   changes anyone's balance.
// - Credit (all top-ups minus all usage) may never go below zero.
//
// Every change runs in one transaction that first locks the account row, so two flatmates
// saving at the same moment can't both pass the credit check.
import { one, all, q, tx } from './db.js';
import { equalSplit, percentSplit, toCents, today, fibreStats } from './calc.js';
import { logActivity } from './activity.js';

// Validation errors. wrap() in index.js turns { code, message } into a 400 for the browser.
const fail = (message) => {
  throw { code: 'INVALID_AMOUNT', message };
};

const MAX_AMOUNT = 99999999.99;   // the largest value NUMERIC(10,2) can hold

// A positive amount with at most two decimal places, returned rounded to whole cents.
export function amountOf(value) {
  const n = Number(value);
  const hasMoreThanTwoDecimals = Math.abs(n * 100 - Math.round(n * 100)) > 0.00001;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT || hasMoreThanTwoDecimals) {
    fail('Enter a positive amount with at most two decimal places.');
  }
  return toCents(n) / 100;
}

// A real calendar day as 'YYYY-MM-DD'; today (household time) when none is given.
// DATE columns already arrive as strings (see db.js). Parsing a date-only string gives UTC
// midnight, so toISOString() returns the same day in any time zone; if it doesn't match,
// the day doesn't exist (2026-02-30 would roll over to 2026-03-02).
function dateOf(value) {
  const day = String(value ?? today());
  const exists = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))
    && new Date(day).toISOString().slice(0, 10) === day;
  if (!exists) fail('Enter a valid date.');
  return day;
}

// Lock the household's prepaid account until the transaction ends, and return it.
export async function utilitiesLock(householdId) {
  return one('SELECT * FROM prepaid_accounts WHERE household_id=$1 ORDER BY id LIMIT 1 FOR UPDATE', [householdId]);
}

// Refuse a change that would leave the account with negative credit.
export async function checkCredit(accountId) {
  const { credit } = await one(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM prepaid_topups WHERE prepaid_account_id=$1)
          - (SELECT COALESCE(SUM(amount), 0) FROM prepaid_usage  WHERE prepaid_account_id=$1) AS credit`,
    [accountId]);
  if (Number(credit) < 0) fail('This change would leave negative prepaid credit. Record missing top-ups first.');
}

// Split a top-up between the active members. Returns { userId: dollars }.
//   equal   – the same for everyone (left-over cents go to the last people)
//   percent – rows [{ user_id, percent }] adding up to 100
//   custom  – rows [{ user_id, fixed_amount }] adding up to the top-up exactly
export async function allocate(amount, users, method = 'equal', rows = []) {
  if (method === 'equal') return equalSplit(amount, users.map((u) => u.id));

  const isMember = (row) => users.some((u) => u.id === row.user_id);
  const oneRowPerMember = Array.isArray(rows) && rows.length === users.length
    && new Set(rows.map((r) => r.user_id)).size === users.length
    && rows.every(isMember);
  if (!['percent', 'custom'].includes(method) || !oneRowPerMember) {
    fail('Provide one allocation for every active member.');
  }

  const field = method === 'percent' ? 'percent' : 'fixed_amount';
  if (rows.some((r) => !Number.isFinite(Number(r[field])) || Number(r[field]) < 0)) {
    fail('Shares must be zero or greater.');
  }

  if (method === 'percent') {
    const totalPercent = rows.reduce((sum, r) => sum + Number(r.percent), 0);
    if (Math.abs(totalPercent - 100) > 0.000001) fail('Percentages must add up to 100%.');
    const split = percentSplit(amount, rows.map((r) => ({ user_id: r.user_id, share_percent: Number(r.percent) })));
    return Object.fromEntries(split.map((s) => [s.user_id, s.share_amount]));
  }

  // custom: whole cents only, and the shares must add up to the top-up to the cent
  const notWholeCents = rows.some((r) => Math.abs(Number(r.fixed_amount) * 100 - toCents(r.fixed_amount)) > 0.00001);
  const totalCents = rows.reduce((sum, r) => sum + toCents(r.fixed_amount), 0);
  if (notWholeCents || totalCents !== toCents(amount)) fail('Custom shares must add up to the top-up.');
  return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.fixed_amount)]));
}

// Insert (no `before`) or update a top-up from the request body.
async function saveTopup(account, before, body, user) {
  const amount = amountOf(body.amount ?? before?.amount);
  const day = dateOf(body.topup_date ?? before?.topup_date);
  const members = await all('SELECT id FROM users WHERE household_id=$1 AND active ORDER BY created_at', [user.household_id]);
  const payer = body.paid_by || before?.paid_by || user.id;
  if (!members.some((m) => m.id === payer)) fail('Choose an active household member as payer.');

  // A new top-up is always split. An edit keeps its saved shares unless a split is sent,
  // and a new amount needs a new split (the old shares would no longer add up).
  const shares = body.method || !before
    ? await allocate(amount, members, body.method || 'equal', body.allocations || [])
    : before.shares;
  if (before && !body.method && amount !== Number(before.amount)) {
    fail('Choose the allocation again when changing a top-up amount.');
  }

  if (before) {
    return one('UPDATE prepaid_topups SET amount=$1, paid_by=$2, topup_date=$3, shares=$4 WHERE id=$5 RETURNING *',
      [amount, payer, day, JSON.stringify(shares), before.id]);
  }
  return one('INSERT INTO prepaid_topups (prepaid_account_id, amount, paid_by, topup_date, shares) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [account.id, amount, payer, day, JSON.stringify(shares)]);
}

// Insert (no `before`) or update a usage entry from the request body.
async function saveUsage(account, before, body) {
  const amount = amountOf(body.amount ?? before?.amount);
  const day = dateOf(body.usage_date ?? before?.usage_date);
  const note = String(body.note ?? before?.note ?? '').slice(0, 500);
  if (before) {
    return one('UPDATE prepaid_usage SET amount=$1, usage_date=$2, note=$3 WHERE id=$4 RETURNING *',
      [amount, day, note, before.id]);
  }
  return one('INSERT INTO prepaid_usage (prepaid_account_id, amount, usage_date, note) VALUES ($1,$2,$3,$4) RETURNING *',
    [account.id, amount, day, note]);
}

// The two kinds of record and how each is stored and logged.
const KINDS = {
  topups: { table: 'prepaid_topups', entity: 'prepaid_topup', label: 'top-up', save: saveTopup },
  usage: { table: 'prepaid_usage', entity: 'prepaid_usage', label: 'usage', save: saveUsage },
};
const ACTIONS = {
  post: { action: 'create', verb: 'Recorded' },
  patch: { action: 'update', verb: 'Edited' },
  delete: { action: 'delete', verb: 'Deleted' },
};

// One handler for create (POST), edit (PATCH) and delete (DELETE) of either kind.
function changeRecord(kindName, method) {
  const kind = KINDS[kindName];
  const { action, verb } = ACTIONS[method];
  return async (req, res) => {
    const result = await tx(async () => {
      const account = await utilitiesLock(req.user.household_id);

      let before = null;
      if (method !== 'post') {
        before = await one(`SELECT * FROM ${kind.table} WHERE id=$1 AND prepaid_account_id=$2`, [req.params.id, account.id]);
        if (!before) throw { code: 'MISSING_FIELD', message: 'Record not found.' };
      }

      let after = null;
      if (method === 'delete') await q(`DELETE FROM ${kind.table} WHERE id=$1`, [before.id]);
      else after = await kind.save(account, before, req.body || {}, req.user);

      await checkCredit(account.id);   // inside the transaction: a refused change is rolled back
      const activity_id = await logActivity({
        householdId: req.user.household_id, userId: req.user.id,
        entityType: kind.entity, entityId: after?.id || before.id, action,
        summary: `${verb} Fibre & Electricity ${kind.label}`, before, after,
      });
      return { ok: true, activity_id, id: after?.id };
    });
    res.json(result);
  };
}

export function registerUtilities(app, wrap) {
  // The account with its stats, and every top-up and usage entry (newest first).
  app.get('/api/prepaid', wrap(async (req, res) => {
    const account = await one('SELECT * FROM prepaid_accounts WHERE household_id=$1 LIMIT 1', [req.user.household_id]);
    const topups = await all(`SELECT t.*, u.name AS paid_by_name FROM prepaid_topups t JOIN users u ON u.id=t.paid_by
                              WHERE prepaid_account_id=$1 ORDER BY topup_date DESC`, [account.id]);
    const usage = await all('SELECT * FROM prepaid_usage WHERE prepaid_account_id=$1 ORDER BY usage_date DESC', [account.id]);
    res.json({ ...account, ...fibreStats(topups, usage), topups, usage });
  }));

  for (const kindName of Object.keys(KINDS)) {
    app.post(`/api/prepaid/${kindName}`, wrap(changeRecord(kindName, 'post')));
    app.patch(`/api/prepaid/${kindName}/:id`, wrap(changeRecord(kindName, 'patch')));
    app.delete(`/api/prepaid/${kindName}/:id`, wrap(changeRecord(kindName, 'delete')));
  }

  // The old account-wide allocation setting. Splits are now chosen per top-up and saved on
  // it, so changing them account-wide would rewrite history; the route stays for old clients.
  app.put('/api/prepaid/allocation', wrap(async () => {
    throw { code: 'INVALID_AMOUNT', message: 'Set allocation on each top-up. Historical shares cannot be changed here.' };
  }));
}
