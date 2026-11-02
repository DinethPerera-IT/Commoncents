import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pool, { q, one, all, tx } from './db.js';
import { migrateAndSeed, materialise } from './seed.js';
import { login, logout, requireAuth, changePassword, publicUser } from './auth.js';
import {
  weekStartOf, addDays, today, currentWeek, equalSplit, round2,
  netBalances, settlementPlan, fibreStats, validateSplits, topupShares, percentSplit, nearestMonday,
} from './calc.js';
import { logActivity, recentActivity, undoActivity } from './activity.js';
import { toCsv } from './csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RECEIPTS = path.join(DATA_DIR, 'receipts');
fs.mkdirSync(RECEIPTS, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: RECEIPTS,
    filename: (_r, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname || '.jpg').slice(0, 8)),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, /^image\//.test(f.mimetype)),
});

const PUBLIC = path.join(__dirname, '..', 'public');

// The container's default gateway from /proc/net/route (hex, little-endian), e.g. 172.18.0.1.
function dockerGateway() {
  try {
    const line = fs.readFileSync('/proc/net/route', 'utf8').split('\n')
      .map((l) => l.trim().split(/\s+/)).find((f) => f[1] === '00000000' && f[2] !== '00000000');
    return line ? [line[2].match(/../g).reverse().map((h) => parseInt(h, 16)).join('.')] : [];
  } catch {
    return [];
  }
}
const app = express();
app.disable('x-powered-by');
// Two ways in: Caddy on the host (commoncents.*.internal) and direct LAN/Tailscale access to
// host:3040. Caddy reaches the container through docker-proxy, so its requests come from the
// Docker network's gateway; LAN clients arrive with their own address. Trust X-Forwarded-For
// only from that gateway (and loopback): then req.ip is the real client either way, and a LAN
// device can't dodge the login rate limit by sending a fake X-Forwarded-For header.
app.set('trust proxy', process.env.TRUST_PROXY || ['loopback', ...dockerGateway()]);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],                     // no inline scripts at all
      scriptSrcAttr: ["'none'"],
      // app.js builds HTML with style="..." attributes (≈150); moving those out is Phase 4.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  strictTransportSecurity: false,               // the site is plain http behind Caddy
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Service worker: its cache name carries a hash of the app shell, so every deploy that
// changes app.js/css/html gets a new cache and the old one is deleted on activate.
const SHELL_FILES = ['index.html', 'app.js', 'industry.css', 'sw-register.js', 'manifest.json'];
const BUILD_ID = crypto.createHash('sha256')
  .update(SHELL_FILES.map((f) => fs.readFileSync(path.join(PUBLIC, f))).join('\0'))
  .digest('hex').slice(0, 10);
const SW_SOURCE = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8').replace('__BUILD_ID__', BUILD_ID);
app.get('/sw.js', (_req, res) => {
  res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }).send(SW_SOURCE);
});
app.use(express.static(PUBLIC));

// Health check for Docker and Uptime Kuma: no login, proves the app can reach Postgres.
app.get('/healthz', async (_req, res) => {
  try {
    await q('SELECT 1');
    res.set('Cache-Control', 'no-store').json({ ok: true, build: BUILD_ID });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// 10 login attempts per 15 min per client IP. Successful logins don't count, so a
// flatmate who types the password right is never locked out by someone else's guesses.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' } },
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  // App errors look like { code: 'FORBIDDEN', message }. Postgres errors also have code+message
  // (code = SQLSTATE like '23503'): those are bugs, so log them and don't send SQL details out.
  if (e && /^[A-Z_]+$/.test(e.code || '') && e.message) return res.status(e.code === 'FORBIDDEN' ? 403 : e.code === 'MISSING_FIELD' ? 404 : 400).json({ error: e });
  console.error(e);
  res.status(500).json({ error: { code: 'DB_ERROR', message: 'Something went wrong on the server.' } });
});
const bad = (res, code, message, field) => res.status(400).json({ error: { code, message, field } });
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d));
// pg returns DATE columns as JS Date objects, not strings — normalise before validating/comparing.
const toISODate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const hid = async () => (await one('SELECT id FROM households LIMIT 1')).id;

// ---- auth ----
app.post('/api/auth/login', loginLimiter, wrap(login));
app.post('/api/auth/logout', wrap(logout));
app.get('/api/auth/members', wrap(async (_req, res) => {
  res.json(await all('SELECT name, initials FROM users WHERE active ORDER BY created_at'));
}));
app.use('/api', requireAuth);
app.post('/api/auth/change-password', wrap(changePassword));
app.get('/api/me', (req, res) => res.json(publicUser(req.user)));

// ---- members ----
app.get('/api/members', wrap(async (_req, res) => {
  res.json((await all('SELECT * FROM users ORDER BY created_at')).map(publicUser));
}));
app.post('/api/members', wrap(async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only.' } });
  const { name, weekly_rent } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'MISSING_FIELD', 'Name is required.', 'name');
  const rent = Number(weekly_rent) || 0;
  if (rent < 0) return bad(res, 'INVALID_AMOUNT', 'Rent cannot be negative.', 'weekly_rent');
  const initials = String(name).trim().slice(0, 2).toUpperCase();
  const u = await one(
    'INSERT INTO users (household_id, name, initials, weekly_rent) VALUES ($1,$2,$3,$4) RETURNING *',
    [await hid(), String(name).trim(), initials, rent]);
  res.json(publicUser(u));
}));
app.patch('/api/members/:id', wrap(async (req, res) => {
  if (!req.user.is_admin && req.user.id !== req.params.id) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only.' } });
  }
  const { name, weekly_rent, active } = req.body || {};
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!u) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such member.' } });
  const newRent = weekly_rent === undefined ? Number(u.weekly_rent) : Number(weekly_rent);
  if (isNaN(newRent) || newRent < 0) return bad(res, 'INVALID_AMOUNT', 'Rent must be a non-negative number.');
  await q('UPDATE users SET name=COALESCE($1,name), weekly_rent=$2, active=COALESCE($3,active) WHERE id=$4',
    [name ? String(name).trim() : null, newRent, active === undefined ? null : !!active, u.id]);
  await q('UPDATE rent_records SET amount_due=$1 WHERE user_id=$2 AND week_start>=$3',
    [newRent, u.id, currentWeek()]);
  res.json({ ok: true });
}));

// ---- categories ----
app.get('/api/categories', wrap(async (_req, res) => {
  res.json(await all('SELECT id, name FROM categories ORDER BY sort'));
}));
app.post('/api/categories', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'MISSING_FIELD', 'Category name required.', 'name');
  const c = await one(
    'INSERT INTO categories (household_id, name, sort) VALUES ($1,$2,99) ON CONFLICT (household_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id, name',
    [await hid(), name]);
  res.json(c);
}));

// ---- weeks / rent ----
app.get('/api/weeks/:weekStart/summary', wrap(async (req, res) => {
  if (!isValidDate(req.params.weekStart)) return bad(res, 'INVALID_DATE', 'Bad week date.');
  const ws = nearestMonday(req.params.weekStart);
  const we = addDays(ws, 7);
  const users = await all('SELECT * FROM users ORDER BY created_at');
  const rent = await all('SELECT * FROM rent_records WHERE week_start=$1', [ws]);
  const exps = await all(
    'SELECT e.*, c.name AS category FROM expenses e JOIN categories c ON c.id=e.category_id WHERE expense_date>=$1 AND expense_date<$2 ORDER BY expense_date',
    [ws, we]);
  const splits = exps.length
    ? await all('SELECT * FROM expense_splits WHERE expense_id = ANY($1)', [exps.map((e) => e.id)])
    : [];
  const rentDue = rent.reduce((s, r) => s + Number(r.amount_due), 0);
  const rentPaid = rent.reduce((s, r) => s + Math.min(Number(r.amount_paid), Number(r.amount_due)), 0);
  const rentCredit = rent.reduce((s, r) => s + Math.max(0, Number(r.amount_paid) - Number(r.amount_due)), 0);
  const byMember = {};
  users.forEach((u) => {
    const r = rent.find((x) => x.user_id === u.id);
    byMember[u.id] = {
      rentDue: r ? Number(r.amount_due) : Number(u.weekly_rent),
      rentPaid: r ? Number(r.amount_paid) : 0,
      rentStatus: r ? r.status : 'unpaid',
      paidFor: round2(exps.filter((e) => e.paid_by === u.id).reduce((s, e) => s + Number(e.amount), 0)),
      share: round2(splits.filter((s) => s.user_id === u.id).reduce((s2, x) => s2 + Number(x.share_amount), 0)),
    };
  });
  res.json({
    week_start: ws, rent_due: round2(rentDue), rent_paid: round2(rentPaid), rent_credit: round2(rentCredit),
    rent_outstanding: round2(Math.max(0, rentDue - rentPaid)),
    spend: round2(exps.reduce((s, e) => s + Number(e.amount), 0)),
    unpaid_items: exps.filter((e) => e.status === 'pending').length + rent.filter((r) => r.status !== 'paid').length,
    by_member: byMember,
    expenses: exps,
  });
}));
app.put('/api/rent/:weekStart/:userId', wrap(async (req, res) => {
  if (!isValidDate(req.params.weekStart)) return bad(res, 'INVALID_DATE', 'Bad week date.');
  const ws = nearestMonday(req.params.weekStart);
  const paid = Number(req.body?.amount_paid);
  if (isNaN(paid) || paid < 0) return bad(res, 'INVALID_AMOUNT', 'Amount must be zero or more.');
  const u = await one('SELECT * FROM users WHERE id=$1', [req.params.userId]);
  if (!u) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such member.' } });
  const before = await one('SELECT * FROM rent_records WHERE user_id=$1 AND week_start=$2', [u.id, ws]);
  const status = paid >= Number(u.weekly_rent) ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  const after = await one(
    'INSERT INTO rent_records (household_id, user_id, week_start, amount_due, amount_paid, status, is_demo) VALUES ($1,$2,$3,$4,$5,$6,false) ON CONFLICT (user_id, week_start) DO UPDATE SET amount_paid=$5, status=$6, is_demo=false, updated_at=now() RETURNING *',
    [await hid(), u.id, ws, u.weekly_rent, round2(paid), status]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'rent_record', entityId: after.id,
    action: 'update', summary: u.name + "'s rent for week of " + ws + ' set to $' + round2(paid).toFixed(2),
    before, after,
  });
  res.json({ ok: true, status, activity_id });
}));

// ---- expenses ----
app.get('/api/expenses', wrap(async (req, res) => {
  const { from, to, category, paid_by, status, q: text, sort } = req.query;
  const conds = [], params = [];
  const add = (sql, v) => { params.push(v); conds.push(sql.replace('?', '$' + params.length)); };
  if (from && isValidDate(from)) add('e.expense_date >= ?', from);
  if (to && isValidDate(to)) add('e.expense_date < ?', to);
  if (category) add('c.name = ?', category);
  if (paid_by) add('e.paid_by = ?', paid_by);
  if (status) add('e.status = ?', status);
  if (text) {
    params.push(String(text));
    const p = '$' + params.length;
    conds.push("(e.description ILIKE '%'||" + p + "||'%' OR c.name ILIKE '%'||" + p + "||'%')");
  }
  const order = sort === 'oldest' ? 'e.expense_date ASC' : sort === 'highest' ? 'e.amount DESC' : 'e.expense_date DESC';
  const rows = await all(
    'SELECT e.*, c.name AS category FROM expenses e JOIN categories c ON c.id=e.category_id' +
    (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' ORDER BY ' + order + ' LIMIT 500', params);
  const splits = rows.length ? await all('SELECT * FROM expense_splits WHERE expense_id = ANY($1)', [rows.map((r) => r.id)]) : [];
  rows.forEach((r) => (r.splits = splits.filter((s) => s.expense_id === r.id)));
  res.json(rows);
}));

async function resolveSplits(method, amount, body, users) {
  let splits = body.splits;
  if (typeof splits === 'string') { try { splits = JSON.parse(splits); } catch { splits = null; } }
  if (method === 'equal') {
    const ids = (splits && splits.length ? splits.map((s) => s.user_id) : users.map((u) => u.id));
    if (!ids.length) return { err: bad2('MISSING_FIELD', 'Pick at least one person to split between.', 'splits') };
    const sh = equalSplit(amount, ids);
    return { splits: ids.map((id) => ({ user_id: id, share_amount: sh[id] })) };
  }
  if (method === 'percent' && splits) {
    splits = percentSplit(amount, splits);
  }
  const err = validateSplits(method, amount, splits);
  if (err) {
    const [code, field] = err.split(':');
    const msg = code === 'SPLIT_MISMATCH' ? 'Custom amounts must add up to the total.'
      : code === 'PERCENT_MISMATCH' ? 'Percentages must add up to 100%.' : 'Split is required.';
    return { err: bad2(code, msg, field) };
  }
  return { splits };
}
function bad2(code, message, field) { return { code, message, field }; }

app.post('/api/expenses', upload.single('receipt'), wrap(async (req, res) => {
  const b = req.body || {};
  const amount = round2(Number(b.amount));
  if (!amount || amount <= 0 || isNaN(amount)) return bad(res, 'INVALID_AMOUNT', 'Enter a valid amount greater than $0.00.', 'amount');
  if (!b.description || !String(b.description).trim()) return bad(res, 'MISSING_FIELD', 'Add a short description.', 'description');
  if (!isValidDate(b.expense_date)) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'expense_date');
  const method = ['equal', 'custom', 'percent'].includes(b.split_method) ? b.split_method : 'equal';
  const users = await all('SELECT id FROM users WHERE active');
  const { splits, err } = await resolveSplits(method, amount, b, users);
  if (err) return bad(res, err.code, err.message, err.field);
  const paidBy = b.paid_by;
  if (!users.some((u) => u.id === paidBy)) return bad(res, 'MISSING_FIELD', 'Pick who paid.', 'paid_by');
  const dup = await one(
    "SELECT id FROM expenses WHERE paid_by=$1 AND amount=$2 AND description=$3 AND expense_date=$4 AND created_at > now() - interval '2 minutes'",
    [paidBy, amount, String(b.description).trim(), b.expense_date]);
  if (dup) return res.status(409).json({ error: { code: 'DUPLICATE_TRANSACTION', message: 'That expense was just added — looks like a double tap.' } });
  const cat = await one('SELECT id FROM categories WHERE name=$1', [b.category]) ||
    await one('SELECT id FROM categories WHERE id=$1', [b.category_id || '00000000-0000-0000-0000-000000000000']);
  if (!cat) return bad(res, 'MISSING_FIELD', 'Pick a category.', 'category');
  const e = await one(
    'INSERT INTO expenses (household_id, category_id, description, amount, expense_date, paid_by, split_method, status, notes, receipt_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [await hid(), cat.id, String(b.description).trim(), amount, b.expense_date, paidBy, method, 'pending', b.notes || null, req.file ? req.file.filename : null]);
  for (const s of splits) {
    await q('INSERT INTO expense_splits (expense_id, user_id, share_amount, share_percent) VALUES ($1,$2,$3,$4)',
      [e.id, s.user_id, round2(Number(s.share_amount) || 0), s.share_percent || null]);
  }
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'expense', entityId: e.id,
    action: 'create', summary: 'Added expense "' + e.description + '" ($' + amount.toFixed(2) + ')',
    after: { ...e, splits },
  });
  res.json({ ...e, activity_id });
}));

app.patch('/api/expenses/:id', upload.single('receipt'), wrap(async (req, res) => {
  const existing = await one('SELECT * FROM expenses WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such expense.' } });
  const existingSplits = await all('SELECT * FROM expense_splits WHERE expense_id=$1', [req.params.id]);
  const before = { ...existing, splits: existingSplits };

  const b = req.body || {};
  const amount = b.amount !== undefined ? round2(Number(b.amount)) : Number(existing.amount);
  if (!amount || amount <= 0 || isNaN(amount)) return bad(res, 'INVALID_AMOUNT', 'Enter a valid amount greater than $0.00.', 'amount');
  const description = b.description !== undefined ? String(b.description).trim() : existing.description;
  if (!description) return bad(res, 'MISSING_FIELD', 'Add a short description.', 'description');
  const expense_date = b.expense_date || toISODate(existing.expense_date);
  if (!isValidDate(toISODate(expense_date))) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'expense_date');
  const method = ['equal', 'custom', 'percent'].includes(b.split_method) ? b.split_method : existing.split_method;
  const paidBy = b.paid_by || existing.paid_by;
  const users = await all('SELECT id FROM users WHERE active');
  if (!users.some((u) => u.id === paidBy)) return bad(res, 'MISSING_FIELD', 'Pick who paid.', 'paid_by');

  let splits;
  if (b.splits !== undefined) {
    const r = await resolveSplits(method, amount, b, users);
    if (r.err) return bad(res, r.err.code, r.err.message, r.err.field);
    splits = r.splits;
  } else {
    splits = existingSplits.map((s) => ({ user_id: s.user_id, share_amount: s.share_amount, share_percent: s.share_percent }));
    const sum = splits.reduce((s, x) => s + Number(x.share_amount), 0);
    if (Math.abs(sum - amount) > 0.01 && method === 'equal') {
      const sh = equalSplit(amount, splits.map((s) => s.user_id));
      splits = splits.map((s) => ({ ...s, share_amount: sh[s.user_id] }));
    } else if (Math.abs(sum - amount) > 0.01) {
      return bad(res, 'SPLIT_MISMATCH', 'Amount changed — re-enter the split so it adds up to the new total.', 'splits');
    }
  }

  let category_id = existing.category_id;
  if (b.category) {
    const cat = await one('SELECT id FROM categories WHERE name=$1', [b.category]);
    if (!cat) return bad(res, 'MISSING_FIELD', 'Pick a category.', 'category');
    category_id = cat.id;
  }
  const receipt_path = req.file ? req.file.filename : existing.receipt_path;

  await q(
    `UPDATE expenses SET category_id=$1, description=$2, amount=$3, expense_date=$4, paid_by=$5, split_method=$6, notes=$7, receipt_path=$8 WHERE id=$9`,
    [category_id, description, amount, expense_date, paidBy, method, b.notes !== undefined ? b.notes : existing.notes, receipt_path, existing.id]);
  await q('DELETE FROM expense_splits WHERE expense_id=$1', [existing.id]);
  for (const s of splits) {
    await q('INSERT INTO expense_splits (expense_id, user_id, share_amount, share_percent) VALUES ($1,$2,$3,$4)',
      [existing.id, s.user_id, round2(Number(s.share_amount) || 0), s.share_percent || null]);
  }
  const after = await one('SELECT * FROM expenses WHERE id=$1', [existing.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'expense', entityId: existing.id,
    action: 'update', summary: 'Edited expense "' + description + '"',
    before, after: { ...after, splits },
  });
  res.json({ ...after, activity_id });
}));

app.post('/api/expenses/:id/settle', wrap(async (req, res) => {
  const before = await one('SELECT * FROM expenses WHERE id=$1', [req.params.id]);
  if (!before) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such expense.' } });
  await q("UPDATE expenses SET status='settled' WHERE id=$1", [req.params.id]);
  const after = await one('SELECT * FROM expenses WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'expense', entityId: before.id,
    action: 'update', summary: 'Marked "' + before.description + '" as settled', before, after,
  });
  res.json({ ok: true, activity_id });
}));
app.delete('/api/expenses/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM expenses WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such expense.' } });
  const splits = await all('SELECT * FROM expense_splits WHERE expense_id=$1', [req.params.id]);
  await q('DELETE FROM expenses WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'expense', entityId: existing.id,
    action: 'delete', summary: 'Deleted expense "' + existing.description + '" ($' + Number(existing.amount).toFixed(2) + ')',
    before: { ...existing, splits },
  });
  res.json({ ok: true, activity_id });
}));
app.get('/api/receipts/:file', wrap(async (req, res) => {
  const f = path.join(RECEIPTS, path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
}));

// ---- bills ----
app.get('/api/bills', wrap(async (req, res) => {
  const rows = await all(
    'SELECT b.*, c.name AS category FROM bills b JOIN categories c ON c.id=b.category_id' +
    (req.query.status ? " WHERE b.status='" + (req.query.status === 'paid' ? 'paid' : 'pending') + "'" : '') +
    ' ORDER BY b.due_date', []);
  res.json(rows);
}));
app.patch('/api/bills/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such bill.' } });
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : existing.name;
  if (!name) return bad(res, 'MISSING_FIELD', 'Bill name is required.', 'name');
  const amount = b.amount !== undefined ? round2(Number(b.amount)) : Number(existing.amount);
  if (!amount || amount <= 0 || isNaN(amount)) return bad(res, 'INVALID_AMOUNT', 'Enter a valid amount greater than $0.00.', 'amount');
  const due_date = b.due_date || toISODate(existing.due_date);
  if (!isValidDate(toISODate(due_date))) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'due_date');
  let category_id = existing.category_id;
  if (b.category) {
    const cat = await one('SELECT id FROM categories WHERE name=$1', [b.category]);
    if (!cat) return bad(res, 'MISSING_FIELD', 'Pick a category.', 'category');
    category_id = cat.id;
  }
  await q('UPDATE bills SET name=$1, amount=$2, due_date=$3, category_id=$4, billing_period=$5 WHERE id=$6',
    [name, amount, due_date, category_id, b.billing_period !== undefined ? b.billing_period : existing.billing_period, existing.id]);
  if (existing.status === 'paid' && existing.expense_id) {
    await q('UPDATE expenses SET amount=$1, description=$2 WHERE id=$3', [amount, name, existing.expense_id]);
  }
  const after = await one('SELECT * FROM bills WHERE id=$1', [existing.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'bill', entityId: existing.id,
    action: 'update', summary: 'Edited bill "' + name + '"', before: existing, after,
  });
  res.json({ ...after, activity_id });
}));
app.delete('/api/bills/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such bill.' } });
  await q('DELETE FROM bills WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'bill', entityId: existing.id,
    action: 'delete', summary: 'Deleted bill "' + existing.name + '"', before: existing,
  });
  res.json({ ok: true, activity_id });
}));
app.post('/api/bills/:id/pay', wrap(async (req, res) => {
  const bill = await one('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!bill) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such bill.' } });
  if (bill.status === 'paid') return bad(res, 'DUPLICATE_TRANSACTION', 'That bill is already paid.');
  const payer = req.body?.paid_by || req.user.id;
  const users = await all('SELECT id FROM users WHERE active');
  const sh = equalSplit(Number(bill.amount), users.map((u) => u.id));
  const e = await one(
    "INSERT INTO expenses (household_id, category_id, description, amount, expense_date, paid_by, split_method, status, notes) VALUES ($1,$2,$3,$4,$5,$6,'equal','pending','From bill') RETURNING id",
    [await hid(), bill.category_id, bill.name, bill.amount, today(), payer]);
  for (const u of users) {
    await q('INSERT INTO expense_splits (expense_id, user_id, share_amount) VALUES ($1,$2,$3)', [e.id, u.id, sh[u.id]]);
  }
  await q("UPDATE bills SET status='paid', paid_by=$1, expense_id=$2 WHERE id=$3", [payer, e.id, bill.id]);
  const after = await one('SELECT * FROM bills WHERE id=$1', [bill.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'bill', entityId: bill.id,
    action: 'update', summary: 'Marked bill "' + bill.name + '" as paid', before: bill, after,
  });
  res.json({ ok: true, activity_id });
}));
app.post('/api/bills/:id/unpay', wrap(async (req, res) => {
  const bill = await one('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!bill) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such bill.' } });
  if (bill.status !== 'paid') return bad(res, 'DUPLICATE_TRANSACTION', 'That bill is not marked paid.');
  // Clear the FK reference before deleting the expense it points to, or the delete violates the constraint.
  await q("UPDATE bills SET status='pending', paid_by=NULL, expense_id=NULL WHERE id=$1", [bill.id]);
  if (bill.expense_id) await q('DELETE FROM expenses WHERE id=$1', [bill.expense_id]);
  const after = await one('SELECT * FROM bills WHERE id=$1', [bill.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'bill', entityId: bill.id,
    action: 'update', summary: 'Reverted bill "' + bill.name + '" to pending', before: bill, after,
  });
  res.json({ ok: true, activity_id });
}));
app.get('/api/recurring-bills', wrap(async (_req, res) => {
  res.json(await all(
    'SELECT r.*, c.name AS category, u.name AS default_payer_name FROM recurring_bills r JOIN categories c ON c.id=r.category_id LEFT JOIN users u ON u.id=r.default_payer WHERE r.active ORDER BY r.name'));
}));

// ---- prepaid (fibre) ----
app.get('/api/prepaid', wrap(async (_req, res) => {
  const acc = await one('SELECT * FROM prepaid_accounts LIMIT 1');
  const topups = await all('SELECT t.*, u.name AS paid_by_name FROM prepaid_topups t JOIN users u ON u.id=t.paid_by WHERE prepaid_account_id=$1 ORDER BY topup_date DESC', [acc.id]);
  const usage = await all('SELECT * FROM prepaid_usage WHERE prepaid_account_id=$1 ORDER BY usage_date DESC', [acc.id]);
  res.json({ ...acc, ...fibreStats(topups, usage), topups, usage });
}));
app.post('/api/prepaid/topups', wrap(async (req, res) => {
  const amount = round2(Number(req.body?.amount));
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Top-up must be more than $0.', 'amount');
  const acc = await one('SELECT id FROM prepaid_accounts LIMIT 1');
  const t = await one('INSERT INTO prepaid_topups (prepaid_account_id, amount, paid_by, topup_date) VALUES ($1,$2,$3,$4) RETURNING *',
    [acc.id, amount, req.body?.paid_by || req.user.id, req.body?.topup_date || today()]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_topup', entityId: t.id,
    action: 'create', summary: 'Recorded fibre top-up of $' + amount.toFixed(2), after: t,
  });
  res.json({ ok: true, activity_id });
}));
app.patch('/api/prepaid/topups/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM prepaid_topups WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such top-up.' } });
  const amount = req.body?.amount !== undefined ? round2(Number(req.body.amount)) : Number(existing.amount);
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Top-up must be more than $0.', 'amount');
  const topup_date = req.body?.topup_date ? toISODate(req.body.topup_date) : toISODate(existing.topup_date);
  if (!isValidDate(topup_date)) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'topup_date');
  await q('UPDATE prepaid_topups SET amount=$1, topup_date=$2 WHERE id=$3', [amount, topup_date, existing.id]);
  const after = await one('SELECT * FROM prepaid_topups WHERE id=$1', [existing.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_topup', entityId: existing.id,
    action: 'update', summary: 'Edited fibre top-up to $' + amount.toFixed(2), before: existing, after,
  });
  res.json({ ok: true, activity_id });
}));
app.delete('/api/prepaid/topups/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM prepaid_topups WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such top-up.' } });
  await q('DELETE FROM prepaid_topups WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_topup', entityId: existing.id,
    action: 'delete', summary: 'Deleted fibre top-up of $' + Number(existing.amount).toFixed(2), before: existing,
  });
  res.json({ ok: true, activity_id });
}));
app.post('/api/prepaid/usage', wrap(async (req, res) => {
  const amount = round2(Number(req.body?.amount));
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Usage must be more than $0.', 'amount');
  const acc = await one('SELECT id FROM prepaid_accounts LIMIT 1');
  const st = await one('SELECT COALESCE(SUM(amount),0) AS up FROM prepaid_topups WHERE prepaid_account_id=$1', [acc.id]);
  const us = await one('SELECT COALESCE(SUM(amount),0) AS used FROM prepaid_usage WHERE prepaid_account_id=$1', [acc.id]);
  if (Number(st.up) - Number(us.used) - amount < -0.01) {
    return bad(res, 'NEGATIVE_BALANCE', 'That would take the prepaid balance below zero.');
  }
  const u = await one('INSERT INTO prepaid_usage (prepaid_account_id, amount, usage_date, note) VALUES ($1,$2,$3,$4) RETURNING *',
    [acc.id, amount, req.body?.usage_date || today(), req.body?.note || null]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_usage', entityId: u.id,
    action: 'create', summary: 'Recorded fibre usage of $' + amount.toFixed(2), after: u,
  });
  res.json({ ok: true, activity_id });
}));
app.patch('/api/prepaid/usage/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM prepaid_usage WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such usage record.' } });
  const amount = req.body?.amount !== undefined ? round2(Number(req.body.amount)) : Number(existing.amount);
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Usage must be more than $0.', 'amount');
  const usage_date = req.body?.usage_date ? toISODate(req.body.usage_date) : toISODate(existing.usage_date);
  if (!isValidDate(usage_date)) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'usage_date');
  const note = req.body?.note !== undefined ? req.body.note : existing.note;
  await q('UPDATE prepaid_usage SET amount=$1, usage_date=$2, note=$3 WHERE id=$4', [amount, usage_date, note, existing.id]);
  const after = await one('SELECT * FROM prepaid_usage WHERE id=$1', [existing.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_usage', entityId: existing.id,
    action: 'update', summary: 'Edited fibre usage to $' + amount.toFixed(2), before: existing, after,
  });
  res.json({ ok: true, activity_id });
}));
app.delete('/api/prepaid/usage/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM prepaid_usage WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such usage record.' } });
  await q('DELETE FROM prepaid_usage WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'prepaid_usage', entityId: existing.id,
    action: 'delete', summary: 'Deleted fibre usage of $' + Number(existing.amount).toFixed(2), before: existing,
  });
  res.json({ ok: true, activity_id });
}));
app.put('/api/prepaid/allocation', wrap(async (req, res) => {
  const method = ['equal', 'percent', 'custom'].includes(req.body?.method) ? req.body.method : 'equal';
  const acc = await one('SELECT id FROM prepaid_accounts LIMIT 1');
  await q('UPDATE prepaid_accounts SET allocation_method=$1 WHERE id=$2', [method, acc.id]);
  await q('DELETE FROM prepaid_allocations WHERE prepaid_account_id=$1', [acc.id]);
  for (const a of req.body?.allocations || []) {
    await q('INSERT INTO prepaid_allocations (prepaid_account_id, user_id, percent, fixed_amount) VALUES ($1,$2,$3,$4)',
      [acc.id, a.user_id, a.percent || null, a.fixed_amount || null]);
  }
  res.json({ ok: true });
}));

// ---- balances & settlements ----
async function balanceInputs() {
  const users = await all('SELECT id, name, initials, active FROM users ORDER BY created_at');
  const expenses = await all('SELECT id, amount, paid_by, is_shared FROM expenses');
  const splits = await all('SELECT * FROM expense_splits');
  const acc = await one('SELECT * FROM prepaid_accounts LIMIT 1');
  const topups = await all('SELECT * FROM prepaid_topups WHERE prepaid_account_id=$1', [acc.id]);
  const allocations = await all('SELECT * FROM prepaid_allocations WHERE prepaid_account_id=$1', [acc.id]);
  const settlements = await all('SELECT * FROM settlements');
  return { users, expenses, splits, topups, allocations, allocationMethod: acc.allocation_method, settlements };
}
app.get('/api/balances', wrap(async (_req, res) => {
  const inputs = await balanceInputs();
  const net = netBalances(inputs);
  res.json({
    net,
    members: inputs.users.map((u) => ({ ...u, net: net[u.id] })),
    plan: settlementPlan(net),
  });
}));
app.get('/api/settlements', wrap(async (_req, res) => {
  res.json(await all(
    'SELECT s.*, p.name AS payer_name, r.name AS recipient_name FROM settlements s JOIN users p ON p.id=s.payer JOIN users r ON r.id=s.recipient ORDER BY settled_on DESC, s.id DESC'));
}));
app.post('/api/settlements', wrap(async (req, res) => {
  const b = req.body || {};
  const amount = round2(Number(b.amount));
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Enter an amount greater than $0.', 'amount');
  if (!b.payer || !b.recipient || b.payer === b.recipient) return bad(res, 'MISSING_FIELD', 'Payer and recipient must be two different people.');
  const date = isValidDate(b.settled_on) ? b.settled_on : today();
  const s = await one('INSERT INTO settlements (household_id, payer, recipient, amount, settled_on, method, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [await hid(), b.payer, b.recipient, amount, date, b.method || 'bank_transfer', b.notes || null]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'settlement', entityId: s.id,
    action: 'create', summary: 'Recorded payment of $' + amount.toFixed(2), after: s,
  });
  res.json({ ok: true, activity_id });
}));
app.patch('/api/settlements/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM settlements WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such settlement.' } });
  const b = req.body || {};
  const amount = b.amount !== undefined ? round2(Number(b.amount)) : Number(existing.amount);
  if (!amount || amount <= 0) return bad(res, 'INVALID_AMOUNT', 'Enter an amount greater than $0.', 'amount');
  const payer = b.payer || existing.payer;
  const recipient = b.recipient || existing.recipient;
  if (payer === recipient) return bad(res, 'MISSING_FIELD', 'Payer and recipient must be two different people.');
  const settled_on = b.settled_on ? toISODate(b.settled_on) : toISODate(existing.settled_on);
  if (!isValidDate(settled_on)) return bad(res, 'INVALID_DATE', 'Enter a valid date.', 'settled_on');
  await q('UPDATE settlements SET payer=$1, recipient=$2, amount=$3, settled_on=$4, method=$5, notes=$6 WHERE id=$7',
    [payer, recipient, amount, settled_on, b.method || existing.method, b.notes !== undefined ? b.notes : existing.notes, existing.id]);
  const after = await one('SELECT * FROM settlements WHERE id=$1', [existing.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'settlement', entityId: existing.id,
    action: 'update', summary: 'Edited payment to $' + amount.toFixed(2), before: existing, after,
  });
  res.json({ ok: true, activity_id });
}));
app.delete('/api/settlements/:id', wrap(async (req, res) => {
  const existing = await one('SELECT * FROM settlements WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such settlement.' } });
  await q('DELETE FROM settlements WHERE id=$1', [req.params.id]);
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'settlement', entityId: existing.id,
    action: 'delete', summary: 'Deleted payment of $' + Number(existing.amount).toFixed(2), before: existing,
  });
  res.json({ ok: true, activity_id });
}));

// ---- reports ----
app.get('/api/reports/categories', wrap(async (req, res) => {
  const { from, to } = req.query;
  const conds = [], params = [];
  if (from && isValidDate(from)) { params.push(from); conds.push('e.expense_date >= $' + params.length); }
  if (to && isValidDate(to)) { params.push(to); conds.push('e.expense_date < $' + params.length); }
  const rows = await all(
    'SELECT c.name, SUM(e.amount) AS total FROM expenses e JOIN categories c ON c.id=e.category_id' +
    (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' GROUP BY c.name ORDER BY total DESC', params);
  const rent = await one(
    'SELECT COALESCE(SUM(LEAST(amount_paid, amount_due)),0) AS total FROM rent_records' +
    (conds.length ? ' WHERE ' + conds.join(' AND ').replaceAll('e.expense_date', 'week_start') : ''), params);
  res.json({ categories: rows, rent_collected: Number(rent.total) });
}));
app.get('/api/reports/weekly', wrap(async (req, res) => {
  const n = Math.min(26, Number(req.query.weeks) || 9);
  const cw = currentWeek();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ws = addDays(cw, -7 * i);
    const r = await one('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date>=$1 AND expense_date<$2', [ws, addDays(ws, 7)]);
    out.push({ week_start: ws, total: Number(r.total) });
  }
  res.json(out);
}));
// Who paid for things, optionally for ?from (inclusive) to ?to (exclusive), like /categories.
app.get('/api/reports/by-member', wrap(async (req, res) => {
  const conds = [], params = [];
  if (isValidDate(req.query.from)) { params.push(req.query.from); conds.push('e.expense_date >= $' + params.length); }
  if (isValidDate(req.query.to)) { params.push(req.query.to); conds.push('e.expense_date < $' + params.length); }
  res.json(await all(
    'SELECT u.id, u.name, COALESCE(SUM(e.amount),0) AS total FROM users u LEFT JOIN expenses e ON e.paid_by=u.id' +
    (conds.length ? ' AND ' + conds.join(' AND ') : '') + ' GROUP BY u.id, u.name ORDER BY u.created_at', params));
}));
// Spending per calendar month (excl. rent), the last ?months (default 6, max 24) up to this NZ month.
app.get('/api/reports/monthly', wrap(async (req, res) => {
  const n = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const months = [today().slice(0, 7)];
  while (months.length < n) {
    const [y, m] = months[0].split('-').map(Number);
    months.unshift(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`);
  }
  const rows = await all(
    "SELECT to_char(expense_date, 'YYYY-MM') AS month, SUM(amount) AS total FROM expenses WHERE expense_date >= $1 GROUP BY 1",
    [months[0] + '-01']);
  res.json(months.map((month) => ({ month, total: Number(rows.find((r) => r.month === month)?.total || 0) })));
}));

// ---- category budgets ----
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
// Every category with its budget (or null) and what was spent in that month (default: this month, NZ).
app.get('/api/budgets', wrap(async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
  const rows = await all(
    `SELECT c.id AS category_id, c.name AS category, b.monthly_amount,
            COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.category_id=c.id
                      AND e.expense_date >= $1 AND e.expense_date < $2), 0) AS spent
     FROM categories c LEFT JOIN category_budgets b ON b.category_id=c.id ORDER BY c.sort, c.name`,
    [month + '-01', nextMonth(month) + '-01']);
  res.json({ month, budgets: rows.map((r) => ({ ...r, monthly_amount: r.monthly_amount === null ? null : Number(r.monthly_amount), spent: Number(r.spent) })) });
}));
// Set (amount > 0) or remove (0 / empty) a category's budget. Admin only; logged, so it can be undone.
app.put('/api/budgets/:categoryId', wrap(async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only.' } });
  const cat = await one('SELECT id, name FROM categories WHERE id=$1', [req.params.categoryId]).catch(() => null);
  if (!cat) return res.status(404).json({ error: { code: 'MISSING_FIELD', message: 'No such category.' } });
  const raw = req.body?.monthly_amount;
  const amount = raw === null || raw === '' || raw === undefined ? 0 : round2(Number(raw));
  if (isNaN(amount) || amount < 0) return bad(res, 'INVALID_AMOUNT', 'Enter a budget of $0 or more.', 'monthly_amount');
  const before = await one('SELECT * FROM category_budgets WHERE category_id=$1', [cat.id]);
  if (!amount && !before) return res.json({ ok: true });
  let after = null;
  if (amount) {
    after = await one(
      `INSERT INTO category_budgets (category_id, household_id, monthly_amount) VALUES ($1,$2,$3)
       ON CONFLICT (category_id) DO UPDATE SET monthly_amount=EXCLUDED.monthly_amount, updated_at=now() RETURNING *`,
      [cat.id, req.user.household_id, amount]);
  } else {
    await q('DELETE FROM category_budgets WHERE category_id=$1', [cat.id]);
  }
  const action = !before ? 'create' : amount ? 'update' : 'delete';
  const summary = amount ? `Set ${cat.name} budget to $${amount.toFixed(2)}/month` : `Removed the ${cat.name} budget`;
  const activity_id = await logActivity({
    householdId: req.user.household_id, userId: req.user.id, entityType: 'budget', entityId: cat.id,
    action, summary, before, after,
  });
  res.json({ ok: true, budget: after, activity_id });
}));

// ---- CSV export (e.g. for end-of-tenancy splits) ----
// ?from=YYYY-MM-DD&to=YYYY-MM-DD, both optional and both inclusive.
function exportRange(req, col) {
  const conds = [], params = [];
  if (isValidDate(req.query.from)) { params.push(req.query.from); conds.push(col + ' >= $' + params.length); }
  if (isValidDate(req.query.to)) { params.push(req.query.to); conds.push(col + ' <= $' + params.length); }
  const label = (isValidDate(req.query.from) ? req.query.from : 'start') + '_to_' + (isValidDate(req.query.to) ? req.query.to : today());
  return { where: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params, label };
}
function sendCsv(res, name, label, header, rows) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="commoncents-${name}-${label}.csv"`,
    'Cache-Control': 'no-store',
  }).send(toCsv(header, rows));
}
const money = (v) => Number(v);
app.get('/api/export/expenses.csv', wrap(async (req, res) => {
  const { where, params, label } = exportRange(req, 'e.expense_date');
  const users = await all('SELECT id, name FROM users ORDER BY created_at');
  const rows = await all(
    'SELECT e.*, c.name AS category, u.name AS payer FROM expenses e JOIN categories c ON c.id=e.category_id ' +
    'JOIN users u ON u.id=e.paid_by' + where + ' ORDER BY e.expense_date, e.created_at', params);
  const splits = await all('SELECT expense_id, user_id, share_amount FROM expense_splits WHERE expense_id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
  const share = (eid, uid) => { const x = splits.find((s) => s.expense_id === eid && s.user_id === uid); return x ? money(x.share_amount) : 0; };
  sendCsv(res, 'expenses', label,
    ['Date', 'Description', 'Category', 'Amount', 'Paid by', 'Split', 'Status', 'Shared', 'Notes', ...users.map((u) => u.name + ' share')],
    rows.map((e) => [toISODate(e.expense_date), e.description, e.category, money(e.amount), e.payer, e.split_method, e.status,
      e.is_shared ? 'yes' : 'no', e.notes, ...users.map((u) => share(e.id, u.id))]));
}));
app.get('/api/export/settlements.csv', wrap(async (req, res) => {
  const { where, params, label } = exportRange(req, 's.settled_on');
  const rows = await all(
    'SELECT s.*, p.name AS payer_name, r.name AS recipient_name FROM settlements s JOIN users p ON p.id=s.payer ' +
    'JOIN users r ON r.id=s.recipient' + where + ' ORDER BY s.settled_on', params);
  sendCsv(res, 'settlements', label, ['Date', 'From', 'To', 'Amount', 'Method', 'Status', 'Notes'],
    rows.map((s) => [toISODate(s.settled_on), s.payer_name, s.recipient_name, money(s.amount), s.method, s.status, s.notes]));
}));
app.get('/api/export/rent.csv', wrap(async (req, res) => {
  const { where, params, label } = exportRange(req, 'r.week_start');
  const rows = await all(
    'SELECT r.*, u.name FROM rent_records r JOIN users u ON u.id=r.user_id' + where + ' ORDER BY r.week_start, u.created_at', params);
  sendCsv(res, 'rent', label, ['Week starting', 'Member', 'Due', 'Paid', 'Status'],
    rows.map((r) => [toISODate(r.week_start), r.name, money(r.amount_due), money(r.amount_paid), r.status]));
}));

// ---- activity / undo ----
app.get('/api/activity', wrap(async (req, res) => {
  res.json(await recentActivity(req.user.household_id, Math.min(100, Number(req.query.limit) || 30)));
}));
app.post('/api/activity/:id/undo', wrap(async (req, res) => {
  const result = await undoActivity(req.params.id, req.user);
  res.json(result);
}));

// ---- admin ----
app.post('/api/admin/reset-demo', wrap(async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin only.' } });
  await tx(async (c) => {
    // Demo payments: demo expenses, plus the expense created when a demo bill was paid
    // (POST /pay inserts it with is_demo=false, so it would otherwise survive as real data).
    const demo = (await c.query(`SELECT id FROM expenses WHERE is_demo
                                 UNION SELECT expense_id FROM bills WHERE is_demo AND expense_id IS NOT NULL`)).rows.map((r) => r.id);
    // A real bill can't point at an expense that's about to go (bills_expense_id_fkey):
    // clear the reference first and put the bill back to pending, the same order as /unpay.
    await c.query(`UPDATE bills SET status='pending', paid_by=NULL, expense_id=NULL
                   WHERE NOT is_demo AND expense_id = ANY($1::uuid[])`, [demo]);
    await c.query('DELETE FROM bills WHERE is_demo');
    await c.query('DELETE FROM expenses WHERE id = ANY($1::uuid[])', [demo]);
    await c.query('DELETE FROM settlements WHERE is_demo');
    await c.query('DELETE FROM prepaid_topups WHERE is_demo');
    await c.query('DELETE FROM prepaid_usage WHERE is_demo');
    await c.query('DELETE FROM rent_records WHERE is_demo');
  });
  res.json({ ok: true, message: 'Demo data removed. Real data was kept — the app now starts fresh from this week.' });
}));

// SPA fallback
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

export { app };

// Start the server: bring the database up to date, then listen. Only when this file is run
// directly (`node server/index.js`); the integration tests import `app` without listening.
export async function start() {
  const PORT = Number(process.env.PORT) || 3040;
  await migrateAndSeed();
  await materialise();
  const timer = setInterval(() => materialise().catch(console.error), 6 * 3600 * 1000);
  const server = app.listen(PORT, '0.0.0.0', () => console.log('CommonCents listening on :' + PORT + ' (build ' + BUILD_ID + ', trusting X-Forwarded-For from ' + JSON.stringify(app.get('trust proxy')) + ')'));
  // `docker compose up -d` / `stop` sends SIGTERM: finish in-flight requests, close the
  // DB pool, exit 0. Without this Docker waits 10 s and then SIGKILLs the app.
  const shutdown = (signal) => {
    console.log(signal + ' received, shutting down');
    clearInterval(timer);
    server.close(() => pool.end().finally(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
