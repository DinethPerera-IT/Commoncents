/* CommonCents SPA — vanilla JS against the /api backend. */
(() => {
const $ = (sel, el) => (el || document).querySelector(sel);
const app = $('#app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toFixed(2);
const signed = (n) => (n >= 0 ? '+' : '\u2212') + '$' + Math.abs(Number(n) || 0).toFixed(2);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const shortDate = (ds) => { const d = new Date(ds + 'T12:00:00'); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
// Dates are 'YYYY-MM-DD' strings. today() is the phone's own calendar date; the arithmetic is
// done in UTC on both ends, so the browser's time zone can't shift a day. (Mixing local noon
// with toISOString() made NZ browsers land a day early: weeks started on Sunday or Saturday.)
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const weekStartOf = (ds) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const S = { me: null, members: [], categories: [], tab: 'dash', weekOff: 0, moreView: 'menu' };

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
  const r = await fetch('/api' + path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw (data.error || { code: 'DB_ERROR', message: 'Request failed.' });
  return data;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'cc-toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
}
function toastUndo(msg, activityId) {
  const t = document.createElement('div');
  t.className = 'cc-toast';
  t.style.display = 'flex'; t.style.alignItems = 'center'; t.style.gap = '10px';
  const span = document.createElement('span'); span.textContent = msg;
  t.appendChild(span);
  if (activityId) {
    const btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.style.cssText = 'background:none;border:none;color:var(--color-accent-100,#eef6ff);text-decoration:underline;font:inherit;cursor:pointer;padding:0;';
    btn.onclick = async () => {
      try { await api('/activity/' + activityId + '/undo', { method: 'POST' }); toast('Undone.'); t.remove(); render(); }
      catch (e) { toast(e.message || 'Could not undo that.'); }
    };
    t.appendChild(btn);
  }
  document.body.appendChild(t); setTimeout(() => t.remove(), 6000);
}
function dialog(title, bodyHtml, onSubmit, submitLabel, extraFooterHtml) {
  const bd = document.createElement('div');
  bd.className = 'dialog-backdrop'; bd.style.zIndex = 60;
  bd.innerHTML = '<div class="dialog blueprint"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
    '<div class="dialog-title">' + esc(title) + '</div><div class="dlg-body" style="display:flex;flex-direction:column;gap:12px;max-height:60dvh;overflow-y:auto;">' + bodyHtml + '</div>' +
    '<div class="dialog-actions">' + (extraFooterHtml || '') + '<button class="btn btn-secondary dlg-cancel" style="min-height:44px;">Cancel</button>' +
    '<button class="btn btn-primary dlg-ok" style="min-height:44px;">' + esc(submitLabel || 'Save') + '</button></div></div>';
  const close = () => bd.remove();
  bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
  $('.dlg-cancel', bd).onclick = close;
  $('.dlg-ok', bd).onclick = async () => {
    try { if ((await onSubmit(bd)) !== false) { close(); render(); } }
    catch (e) { toast(e.message || 'Something went wrong.'); }
  };
  document.body.appendChild(bd);
  return bd;
}
function confirmDialog(msg, onYes) {
  const bd = document.createElement('div');
  bd.className = 'dialog-backdrop'; bd.style.zIndex = 70;
  bd.innerHTML = '<div class="dialog blueprint" style="max-width:340px;"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
    '<div class="dialog-title">Are you sure?</div><div class="dlg-body">' + esc(msg) + '</div>' +
    '<div class="dialog-actions"><button class="btn btn-secondary dc-no" style="min-height:44px;">Cancel</button>' +
    '<button class="btn btn-primary dc-yes" style="min-height:44px;">Delete</button></div></div>';
  bd.addEventListener('click', (e) => { if (e.target === bd) bd.remove(); });
  $('.dc-no', bd).onclick = () => bd.remove();
  $('.dc-yes', bd).onclick = async () => {
    try { await onYes(); bd.remove(); render(); } catch (e) { toast(e.message || 'Something went wrong.'); }
  };
  document.body.appendChild(bd);
}
const field = (label, inner) => '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>';
const input = (cls, attrs) => '<input class="input ' + (cls || '') + '" ' + (attrs || '') + '>';
const card = (inner, style) => '<div class="card blueprint" style="' + (style || '') + '"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' + inner + '</div>';
const iconBtn = (cls, id, svgPath, title) => '<button class="btn btn-icon ' + cls + '" data-id="' + esc(id) + '" title="' + esc(title) + '" style="min-height:32px;min-width:32px;padding:0;">' +
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + svgPath + '"></path></svg></button>';
const PENCIL = 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z';
const TRASH = 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z';

// ---------- login ----------
async function renderLogin() {
  let members = [];
  try { members = await fetch('/api/auth/members').then((r) => r.json()); } catch (e) {}
  app.innerHTML = '<div style="min-height:100dvh;display:grid;place-items:center;padding:20px;">' +
    card('<div class="card-kicker">Household finances</div><h2 style="margin:0 0 4px;">CommonCents</h2>' +
      '<div class="text-muted" style="font-size:13px;margin-bottom:8px;">Sign in to your flat</div>' +
      field('Who are you?', '<div style="display:flex;gap:8px;flex-wrap:wrap;" id="who">' +
        members.map((m, i) => '<button class="btn ' + (i === 0 ? 'btn-primary' : 'btn-secondary') + '" data-name="' + esc(m.name) + '" style="min-height:44px;">' + esc(m.name) + '</button>').join('') + '</div>') +
      field('Password', input('', 'type="password" id="pw" autocomplete="current-password"')) +
      '<button class="btn btn-primary btn-block" style="min-height:48px;" id="go">Sign in</button>' +
      '<div class="card-meta">First time? The shared starting password is set by your admin.</div>',
      'width:min(400px,92vw);padding:24px;gap:12px;') + '</div>';
  let who = members[0] ? members[0].name : '';
  $('#who').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    who = b.dataset.name;
    $('#who').querySelectorAll('button').forEach((x) => (x.className = 'btn ' + (x === b ? 'btn-primary' : 'btn-secondary')));
  };
  const go = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: { name: who, password: $('#pw').value } });
      S.me = r.user; boot();
    } catch (e) { toast(e.message); }
  };
  $('#go').onclick = go;
  $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// ---------- shell ----------
const NAV = [
  ['dash', 'Home', 'M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z'],
  ['expenses', 'Expenses', 'M4 3h16v18l-3-2-3 2-2-2-2 2-3-2-3 2zM8 8h8M8 12h8M8 16h5'],
  ['bills', 'Bills', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4'],
  ['balances', 'Balances', 'M12 3v18M7 7l-4 5a4 4 0 0 0 8 0zM17 7l-4 5M17 7l4 5a4 4 0 0 1-8 0zM7 7h10'],
  ['more', 'More', 'M5 12h.01M12 12h.01M19 12h.01'],
];
function shell(contentHtml) {
  app.innerHTML = '<div class="cc-shell">' +
    '<nav class="cc-nav">' + NAV.map(([id, label, icon]) =>
      '<button class="' + (S.tab === id ? 'on' : '') + '" data-tab="' + id + '">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="' + icon + '"></path></svg>' +
      '<span>' + label + '</span></button>').join('') + '</nav>' +
    '<main class="cc-main"><div class="cc-content">' +
    '<header style="display:flex;align-items:center;gap:12px;">' +
    '<div style="font-family:var(--font-heading);font-weight:600;font-size:22px;">CommonCents</div>' +
    '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;">' +
    '<span class="text-muted" style="font-size:13px;">' + esc(S.me.name) + '</span>' +
    '<div class="cc-avatar" style="width:30px;height:30px;font-size:11px;">' + esc(S.me.initials) + '</div></div></header>' +
    '<div id="view">' + contentHtml + '</div>' +
    '</div></main></div>';
  app.querySelector('.cc-nav').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab; S.moreView = 'menu'; render();
  };
}
const view = () => $('#view');
const spinner = '<div class="text-muted" style="padding:32px;text-align:center;font-size:13px;">Loading\u2026</div>';

// ---------- dashboard ----------
async function renderDash() {
  const ws = addDays(weekStartOf(today()), S.weekOff * 7);
  const [sum, bal, prepaid, bills] = await Promise.all([
    api('/weeks/' + ws + '/summary'), api('/balances'), api('/prepaid'), api('/bills'),
  ]);
  const isCur = S.weekOff === 0;
  const myNet = bal.net[S.me.id] || 0;
  const outstanding = sum.rent_outstanding + sum.expenses.filter((e) => e.status === 'pending').reduce((s, e) => s + Number(e.amount), 0);
  const latestBill = (cat) => {
    const list = bills.filter((b) => b.category === cat).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const next = list.find((b) => b.status === 'pending') || list[list.length - 1];
    return next ? { v: fmt(next.amount), s: next.status === 'pending' ? 'due ' + shortDate(next.due_date.slice(0, 10)) : 'paid' } : { v: '$0.00', s: 'no bills yet' };
  };
  const catWk = {};
  sum.expenses.forEach((e) => (catWk[e.category] = (catWk[e.category] || 0) + Number(e.amount)));
  const cards = [
    ['Rent this week', fmt(sum.rent_paid), 'of ' + fmt(sum.rent_due) + ' due' + (sum.rent_credit ? ' \u00b7 ' + fmt(sum.rent_credit) + ' credit' : '')],
    ['Outstanding', fmt(outstanding), sum.unpaid_items + ' unpaid item' + (sum.unpaid_items === 1 ? '' : 's')],
    ['Fibre prepaid', fmt(prepaid.balance), '~empty ' + shortDate(prepaid.est_depletion_date)],
    ['Groceries', fmt(catWk['Groceries'] || 0), isCur ? 'this week' : 'that week'],
    ['Electricity', latestBill('Electricity').v, latestBill('Electricity').s],
    ['Water', latestBill('Water').v, latestBill('Water').s],
    ['Spending', fmt(sum.spend), sum.expenses.length + ' expenses'],
    ['Your balance', signed(myNet), myNet >= 0.01 ? 'you are owed' : myNet <= -0.01 ? 'you owe' : 'all square'],
  ];
  view().innerHTML =
    '<div style="display:flex;flex-direction:column;gap:16px;">' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    '<button class="btn btn-icon" id="wPrev">\u2039</button>' +
    '<div style="flex:1;text-align:center;"><div class="cc-num" style="font-size:18px;">' + (isCur ? 'This week' : 'Week of ' + shortDate(ws)) + '</div>' +
    '<div class="text-muted" style="font-size:12px;">' + shortDate(ws) + ' \u2013 ' + shortDate(addDays(ws, 6)) + '</div></div>' +
    '<button class="btn btn-icon" id="wNext" ' + (isCur ? 'disabled' : '') + '>\u203a</button></div>' +
    card('<div class="card-kicker">Household balance</div>' +
      '<div class="cc-num" style="font-size:40px;line-height:1;">' + fmt(sum.spend) + '</div>' +
      '<div class="text-muted" style="font-size:13px;">spent ' + (isCur ? 'this week' : 'that week') + ' \u00b7 ' + fmt(outstanding) + ' outstanding</div>' +
      '<div style="display:flex;justify-content:center;gap:16px;font-size:13px;margin-top:4px;">' +
      '<span>You owe <strong>' + fmt(Math.max(0, -myNet)) + '</strong></span>' +
      '<span>You are owed <strong class="cc-pos">' + fmt(Math.max(0, myNet)) + '</strong></span></div>',
      'padding:20px;text-align:center;gap:4px;') +
    '<div class="cc-cards">' + cards.map(([l, v, s]) =>
      card('<div class="card-kicker">' + l + '</div><div class="cc-num" style="font-size:22px;">' + v + '</div><div class="card-meta">' + s + '</div>', 'gap:2px;min-height:84px;')).join('') + '</div>' +
    card('<div class="card-kicker" style="margin-bottom:8px;">Flatmate balances \u2014 week of ' + shortDate(ws) + '</div>' +
      S.members.map((m) => {
        const b = sum.by_member[m.id]; const n = bal.net[m.id] || 0;
        const credit = Math.max(0, b.rentPaid - b.rentDue);
        const tag = b.rentStatus === 'paid' ? (credit ? ['tag tag-accent', 'Credit ' + fmt(credit)] : ['tag tag-accent', 'Rent paid'])
          : b.rentStatus === 'partial' ? ['tag tag-neutral', 'Partial ' + fmt(b.rentPaid)] : ['tag tag-outline', 'Rent unpaid'];
        return '<div class="cc-row" style="cursor:pointer;" data-rent="' + m.id + '">' +
          '<div class="cc-avatar">' + esc(m.initials) + '</div>' +
          '<div style="flex:1;min-width:0;"><div style="font-weight:500;font-size:14px;">' + esc(m.name) + '</div>' +
          '<div class="text-muted" style="font-size:12px;">Rent ' + fmt(b.rentDue) + ' \u00b7 paid for others ' + fmt(b.paidFor) + ' \u00b7 share ' + fmt(b.share) + '</div></div>' +
          '<div style="text-align:right;"><span class="' + tag[0] + '">' + tag[1] + '</span>' +
          '<div class="cc-num ' + (n >= 0.01 ? 'cc-pos' : 'cc-neg') + '" style="font-size:13px;margin-top:3px;">' + signed(n) + '</div></div></div>';
      }).join('') +
      '<div class="card-meta" style="margin-top:6px;">Tap a flatmate to record rent \u00b7 net = who-owes-who across all weeks</div>', 'gap:0;') +
    '</div>';
  $('#wPrev').onclick = () => { S.weekOff--; render(); };
  $('#wNext').onclick = () => { if (S.weekOff < 0) { S.weekOff++; render(); } };
  view().querySelectorAll('[data-rent]').forEach((el) => (el.onclick = () => rentDialog(el.dataset.rent, ws, sum)));
}
function rentDialog(memberId, ws, sum) {
  const m = S.members.find((x) => x.id === memberId);
  const b = sum.by_member[memberId];
  const bd = dialog('Rent \u2014 ' + m.name,
    '<div class="dialog-body">Due ' + fmt(b.rentDue) + ' for the week of ' + shortDate(ws) + '. Paid so far: ' + fmt(b.rentPaid) + '.</div>' +
    field('Amount paid this week', input('', 'type="number" inputmode="decimal" id="rentAmt" value="' + b.rentPaid + '"')) +
    '<div style="display:flex;gap:8px;">' +
    '<button class="btn btn-secondary rq" data-v="' + b.rentDue + '" style="flex:1;min-height:44px;">Full</button>' +
    '<button class="btn btn-secondary rq" data-v="' + (b.rentDue / 2) + '" style="flex:1;min-height:44px;">Half</button>' +
    '<button class="btn btn-secondary rq" data-v="0" style="flex:1;min-height:44px;">Unpaid</button></div>',
    async (dlg) => {
      const v = Number($('#rentAmt', dlg).value);
      if (isNaN(v) || v < 0) { toast('Enter a valid amount.'); return false; }
      const r = await api('/rent/' + ws + '/' + memberId, { method: 'PUT', body: { amount_paid: v } });
      toastUndo('Rent updated for ' + m.name + '.', r.activity_id);
    });
  bd.querySelectorAll('.rq').forEach((btn) => (btn.onclick = () => ($('#rentAmt', bd).value = btn.dataset.v)));
}

// ---------- expenses ----------
const F = { q: '', category: '', paid_by: '', status: '', sort: 'newest' };
async function renderExpenses() {
  const params = new URLSearchParams();
  Object.entries(F).forEach(([k, v]) => { if (v) params.set(k === 'sort' ? 'sort' : k, v); });
  const rows = await api('/expenses?' + params);
  const name = (id) => { const m = S.members.find((x) => x.id === id); return m ? m.name : '\u2014'; };
  const sel = (id, opts, cur) => '<select class="input exp-f" data-k="' + id + '" style="width:auto;flex:1;min-width:100px;">' +
    opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' +
    '<div style="display:flex;gap:8px;">' +
    input('exp-f', 'placeholder="Search expenses" data-k="q" value="' + esc(F.q) + '" style="flex:1;"') +
    '<button class="btn btn-primary" id="addExp" style="min-height:44px;white-space:nowrap;">+ Add expense</button></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
    sel('category', [['', 'All categories']].concat(S.categories.map((c) => [c.name, c.name])), F.category) +
    sel('paid_by', [['', 'Everyone']].concat(S.members.map((m) => [m.id, m.name])), F.paid_by) +
    sel('status', [['', 'All statuses'], ['pending', 'Pending'], ['settled', 'Settled']], F.status) +
    sel('sort', [['newest', 'Newest'], ['oldest', 'Oldest'], ['highest', 'Highest']], F.sort) + '</div>' +
    card('<div class="card-kicker" style="margin-bottom:4px;">' + rows.length + ' transactions</div>' +
      rows.map((e) => '<div class="cc-row">' +
        '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(e.description) + '</div>' +
        '<div class="text-muted" style="font-size:12px;">' + shortDate(e.expense_date.slice(0, 10)) + ' \u00b7 ' + esc(e.category) + ' \u00b7 ' + esc(name(e.paid_by)) + ' paid \u00b7 ' +
        (e.split_method === 'equal' ? 'split equally' : e.split_method + ' split') +
        (e.receipt_path ? ' \u00b7 <a href="/api/receipts/' + esc(e.receipt_path) + '" target="_blank">receipt</a>' : '') + '</div></div>' +
        '<div style="text-align:right;flex:none;display:flex;align-items:center;gap:4px;"><div class="cc-num" style="font-size:16px;">' + fmt(e.amount) + '</div>' +
        (e.status === 'settled' ? '<span class="tag tag-accent" style="font-size:10px;">settled</span>'
          : '<button class="btn btn-ghost exp-settle" data-id="' + e.id + '" style="min-height:32px;font-size:12px;">mark settled</button>') +
        iconBtn('exp-edit', e.id, PENCIL, 'Edit') + iconBtn('exp-del', e.id, TRASH, 'Delete') +
        '</div></div>').join(''), 'gap:0;') + '</div>';
  view().querySelectorAll('.exp-f').forEach((el) => {
    el.onchange = () => { F[el.dataset.k] = el.value; render(); };
  });
  view().querySelectorAll('.exp-settle').forEach((el) => (el.onclick = async () => {
    try { const r = await api('/expenses/' + el.dataset.id + '/settle', { method: 'POST' }); toastUndo('Marked settled.', r.activity_id); render(); } catch (e) { toast(e.message); }
  }));
  view().querySelectorAll('.exp-edit').forEach((el) => (el.onclick = () => {
    const row = rows.find((r) => r.id === el.dataset.id);
    if (row) expenseDialog(row);
  }));
  view().querySelectorAll('.exp-del').forEach((el) => (el.onclick = () => {
    const row = rows.find((r) => r.id === el.dataset.id);
    confirmDialog('Delete "' + row.description + '" (' + fmt(row.amount) + ')? This cannot be undone from here — but it will be logged, so you can still undo it from Activity.', async () => {
      const r = await api('/expenses/' + row.id, { method: 'DELETE' });
      toastUndo('Expense deleted.', r.activity_id);
    });
  }));
  $('#addExp').onclick = () => expenseDialog(null);
}
function expenseDialog(existing) {
  const isEdit = !!existing;
  let method = existing ? existing.split_method : 'equal';
  const between = {};
  if (existing) {
    (existing.splits || []).forEach((s) => (between[s.user_id] = true));
  } else {
    S.members.forEach((m) => (between[m.id] = true));
  }
  const bd = dialog(isEdit ? 'Edit expense' : 'Add expense',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
    field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="xAmt" placeholder="0.00" value="' + (existing ? Number(existing.amount) : '') + '"')) +
    field('Date', input('', 'type="date" id="xDate" value="' + (existing ? existing.expense_date.slice(0, 10) : today()) + '"')) + '</div>' +
    field('Category', '<select class="input" id="xCat">' + S.categories.filter((c) => c.name !== 'Rent').map((c) =>
      '<option' + ((existing ? existing.category === c.name : c.name === 'Groceries') ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>') +
    field('Description', input('', 'id="xDesc" placeholder="e.g. Weekly grocery shop" value="' + (existing ? esc(existing.description) : '') + '"')) +
    field('Paid by', '<div class="seg" style="width:100%;" id="xPayer">' + S.members.map((m) =>
      '<label class="seg-opt" style="flex:1;justify-content:center;min-height:42px;"><input type="radio" name="xp" value="' + m.id + '"' + ((existing ? existing.paid_by === m.id : m.id === S.me.id) ? ' checked' : '') + '>' + esc(m.initials) + '</label>').join('') + '</div>') +
    field('Split method', '<div class="seg" style="width:100%;" id="xMethod">' +
      [['equal', 'Equal'], ['custom', 'Custom $'], ['percent', '%']].map(([v, l]) =>
        '<label class="seg-opt" style="flex:1;justify-content:center;min-height:42px;"><input type="radio" name="xm" value="' + v + '"' + (v === method ? ' checked' : '') + '>' + l + '</label>').join('') + '</div>') +
    '<div id="xSplitArea"></div>' +
    field('Receipt / photo (optional)', input('', 'type="file" accept="image/*" id="xFile" style="padding-top:7px;"')) +
    field('Notes (optional)', input('', 'id="xNotes" value="' + (existing && existing.notes ? esc(existing.notes) : '') + '"')),
    async (dlg) => {
      const amount = Number($('#xAmt', dlg).value);
      const fd = new FormData();
      fd.append('amount', amount);
      fd.append('expense_date', $('#xDate', dlg).value);
      fd.append('category', $('#xCat', dlg).value);
      fd.append('description', $('#xDesc', dlg).value);
      fd.append('paid_by', dlg.querySelector('input[name=xp]:checked').value);
      fd.append('split_method', method);
      fd.append('notes', $('#xNotes', dlg).value);
      let splits;
      if (method === 'equal') {
        splits = S.members.filter((m) => between[m.id]).map((m) => ({ user_id: m.id }));
        if (!splits.length) { toast('Pick at least one person to split between.'); return false; }
      } else {
        splits = S.members.map((m) => {
          const v = Number($('#ms-' + m.id, dlg)?.value) || 0;
          return method === 'custom' ? { user_id: m.id, share_amount: v } : { user_id: m.id, share_percent: v };
        });
      }
      fd.append('splits', JSON.stringify(splits));
      const f = $('#xFile', dlg).files[0];
      if (f) fd.append('receipt', f);
      const r = await api(isEdit ? '/expenses/' + existing.id : '/expenses', { method: isEdit ? 'PATCH' : 'POST', body: fd });
      toastUndo(isEdit ? 'Expense updated.' : 'Expense added.', r.activity_id);
    }, isEdit ? 'Save changes' : 'Save expense',
    isEdit ? '<button class="btn btn-ghost xDelBtn" style="min-height:44px;margin-right:auto;color:var(--color-neutral-800,#2b2b2d);">Delete</button>' : '');
  const renderSplit = () => {
    const area = $('#xSplitArea', bd);
    if (method === 'equal') {
      area.innerHTML = field('Split between', '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        S.members.map((m) => '<button class="btn ' + (between[m.id] ? 'btn-primary' : 'btn-secondary') + ' xb" data-id="' + m.id + '" style="min-height:38px;font-size:13px;">' + esc(m.name) + '</button>').join('') + '</div>');
      area.querySelectorAll('.xb').forEach((b) => (b.onclick = () => { between[b.dataset.id] = !between[b.dataset.id]; renderSplit(); }));
    } else {
      const existingFor = (uid) => {
        if (!existing) return '';
        const s = (existing.splits || []).find((x) => x.user_id === uid);
        if (!s) return '';
        return method === 'custom' ? (s.share_amount ?? '') : (s.share_percent ?? '');
      };
      area.innerHTML = field(method === 'custom' ? 'Amount per person (must sum to total)' : 'Percent per person (must sum to 100)',
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
        S.members.map((m) => '<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:13px;width:58px;">' + esc(m.name) + '</span>' +
          input('', 'type="number" inputmode="decimal" id="ms-' + m.id + '" value="' + existingFor(m.id) + '"') + '</div>').join('') + '</div>');
    }
  };
  renderSplit();
  bd.querySelectorAll('input[name=xm]').forEach((r) => (r.onchange = () => { method = r.value; renderSplit(); }));
  const delBtn = $('.xDelBtn', bd);
  if (delBtn) delBtn.onclick = () => {
    confirmDialog('Delete "' + existing.description + '" (' + fmt(existing.amount) + ')?', async () => {
      const r = await api('/expenses/' + existing.id, { method: 'DELETE' });
      bd.remove();
      toastUndo('Expense deleted.', r.activity_id);
    });
  };
}

// ---------- bills ----------
async function renderBills() {
  const [bills, recs] = await Promise.all([api('/bills'), api('/recurring-bills')]);
  const name = (id) => { const m = S.members.find((x) => x.id === id); return m ? m.name : '\u2014'; };
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;"><h4 style="margin:0;">Bills</h4>' +
    bills.map((b) => {
      const due = b.due_date.slice(0, 10);
      const overdue = b.status === 'pending' && due < today();
      return card('<div style="flex:1;min-width:0;"><div style="font-weight:500;font-size:14px;">' + esc(b.name) + '</div>' +
        '<div class="text-muted" style="font-size:12px;">' + (b.status === 'paid' ? 'Paid by ' + esc(name(b.paid_by)) : 'Due ' + shortDate(due)) + ' \u00b7 ' + esc(b.billing_period || '') + '</div></div>' +
        '<div class="cc-num" style="font-size:18px;">' + fmt(b.amount) + '</div>' +
        (b.status === 'pending'
          ? '<button class="btn btn-secondary bill-pay" data-id="' + b.id + '" style="min-height:40px;">Mark paid</button>' +
            (overdue ? '<span class="tag tag-outline">Overdue</span>' : '')
          : '<button class="btn btn-ghost bill-unpay" data-id="' + b.id + '" style="min-height:32px;font-size:12px;">undo paid</button>') +
        iconBtn('bill-edit', b.id, PENCIL, 'Edit') + iconBtn('bill-del', b.id, TRASH, 'Delete'),
        'flex-direction:row;align-items:center;gap:12px;');
    }).join('') +
    card('<div class="card-kicker" style="margin-bottom:6px;">Recurring</div>' +
      recs.map((r) => '<div class="cc-row" style="padding:9px 0;font-size:13px;">' +
        '<div style="flex:1;">' + esc(r.name) + ' <span class="text-muted">\u00b7 ' + esc(r.due_rule || '') + (r.default_payer_name ? ' \u00b7 usually ' + esc(r.default_payer_name) : '') + '</span></div>' +
        '<span class="tag tag-neutral" style="font-size:10px;">' + esc(r.frequency) + '</span>' +
        '<div class="cc-num" style="min-width:56px;text-align:right;">' + fmt(r.expected_amount) + '</div></div>').join(''), 'gap:0;') + '</div>';
  view().querySelectorAll('.bill-pay').forEach((el) => (el.onclick = async () => {
    try { const r = await api('/bills/' + el.dataset.id + '/pay', { method: 'POST', body: {} }); toastUndo('Bill marked paid \u2014 shared expense created.', r.activity_id); render(); }
    catch (e) { toast(e.message); }
  }));
  view().querySelectorAll('.bill-unpay').forEach((el) => (el.onclick = async () => {
    try { const r = await api('/bills/' + el.dataset.id + '/unpay', { method: 'POST' }); toastUndo('Reverted to pending.', r.activity_id); render(); }
    catch (e) { toast(e.message); }
  }));
  view().querySelectorAll('.bill-edit').forEach((el) => (el.onclick = () => {
    const b = bills.find((x) => x.id === el.dataset.id);
    billDialog(b);
  }));
  view().querySelectorAll('.bill-del').forEach((el) => (el.onclick = () => {
    const b = bills.find((x) => x.id === el.dataset.id);
    confirmDialog('Delete bill "' + b.name + '"?', async () => {
      const r = await api('/bills/' + b.id, { method: 'DELETE' });
      toastUndo('Bill deleted.', r.activity_id);
    });
  }));
}
function billDialog(b) {
  dialog('Edit bill',
    field('Name', input('', 'id="bName" value="' + esc(b.name) + '"')) +
    field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="bAmt" value="' + Number(b.amount) + '"')) +
    field('Due date', input('', 'type="date" id="bDue" value="' + b.due_date.slice(0, 10) + '"')) +
    field('Category', '<select class="input" id="bCat">' + S.categories.map((c) =>
      '<option' + (c.name === b.category ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>') +
    field('Billing period (optional)', input('', 'id="bPeriod" value="' + esc(b.billing_period || '') + '"')),
    async (dlg) => {
      const r = await api('/bills/' + b.id, { method: 'PATCH', body: {
        name: $('#bName', dlg).value, amount: Number($('#bAmt', dlg).value),
        due_date: $('#bDue', dlg).value, category: $('#bCat', dlg).value, billing_period: $('#bPeriod', dlg).value } });
      toastUndo('Bill updated.', r.activity_id);
    });
}

// ---------- balances ----------
async function renderBalances() {
  const [bal, hist] = await Promise.all([api('/balances'), api('/settlements')]);
  const name = (id) => { const m = S.members.find((x) => x.id === id); return m ? m.name : '\u2014'; };
  const myNet = bal.net[S.me.id] || 0;
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' +
    card('<div class="card-kicker">' + esc(S.me.name) + ' \u2014 net balance</div>' +
      '<div class="cc-num ' + (myNet >= 0.01 ? 'cc-pos' : '') + '" style="font-size:36px;line-height:1;">' + signed(myNet) + '</div>' +
      '<div class="text-muted" style="font-size:13px;">' + (myNet >= 0.01 ? 'You are owed overall' : myNet <= -0.01 ? 'You owe overall' : 'All square') + '</div>',
      'padding:18px;text-align:center;gap:4px;') +
    card('<div class="card-kicker" style="margin-bottom:6px;">Net balances</div>' +
      bal.members.map((m) => '<div class="cc-row">' +
        '<div class="cc-avatar" style="width:32px;height:32px;font-size:12px;">' + esc(m.initials) + '</div>' +
        '<div style="flex:1;font-size:14px;font-weight:500;">' + esc(m.name) + '</div>' +
        '<div class="text-muted" style="font-size:12px;">' + (m.net >= 0.01 ? 'is owed' : m.net <= -0.01 ? 'owes' : 'square') + '</div>' +
        '<div class="cc-num ' + (m.net >= 0.01 ? 'cc-pos' : 'cc-neg') + '" style="font-size:16px;min-width:72px;text-align:right;">' + signed(m.net) + '</div></div>').join(''), 'gap:0;') +
    card('<div class="card-kicker">Suggested settlements</div>' +
      (bal.plan.length === 0 ? '<div class="text-muted" style="font-size:13px;">Everyone is square. Nice.</div>' :
        bal.plan.map((p, i) => '<div style="display:flex;align-items:center;gap:10px;font-size:14px;">' +
          '<div style="flex:1;"><strong>' + esc(name(p.from)) + '</strong> pays <strong>' + esc(name(p.to)) + '</strong></div>' +
          '<div class="cc-num">' + fmt(p.amount) + '</div>' +
          '<button class="btn btn-primary settle" data-i="' + i + '" style="min-height:38px;padding-inline:12px;">Settle up</button></div>').join('')), 'gap:8px;') +
    card('<div class="card-kicker" style="margin-bottom:4px;">Settlement history</div>' +
      hist.map((s) => '<div class="cc-row" style="padding:9px 0;font-size:13px;">' +
        '<div style="flex:1;">' + esc(s.payer_name) + ' \u2192 ' + esc(s.recipient_name) +
        ' <span class="text-muted">\u00b7 ' + shortDate(s.settled_on.slice(0, 10)) + ' \u00b7 ' + esc(s.method) + (s.notes ? ' \u00b7 ' + esc(s.notes) : '') + '</span></div>' +
        '<div class="cc-num">' + fmt(s.amount) + '</div>' +
        iconBtn('st-edit', s.id, PENCIL, 'Edit') + iconBtn('st-del', s.id, TRASH, 'Delete') + '</div>').join(''), 'gap:0;') + '</div>';
  view().querySelectorAll('.settle').forEach((el) => (el.onclick = () => {
    const p = bal.plan[Number(el.dataset.i)];
    dialog('Settle up',
      '<div class="dialog-body"><strong>' + esc(name(p.from)) + '</strong> pays <strong>' + esc(name(p.to)) + '</strong></div>' +
      field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="sAmt" value="' + p.amount + '"')) +
      field('Payment method', '<select class="input" id="sMethod"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option></select>') +
      field('Notes (optional)', input('', 'id="sNotes"')),
      async (dlg) => {
        const r = await api('/settlements', { method: 'POST', body: {
          payer: p.from, recipient: p.to, amount: Number($('#sAmt', dlg).value),
          method: $('#sMethod', dlg).value, notes: $('#sNotes', dlg).value } });
        toastUndo('Payment recorded.', r.activity_id);
      }, 'Record payment');
  }));
  view().querySelectorAll('.st-edit').forEach((el) => (el.onclick = () => {
    const s = hist.find((x) => x.id === el.dataset.id);
    dialog('Edit payment',
      field('Payer', '<select class="input" id="esPayer">' + S.members.map((m) => '<option value="' + m.id + '"' + (m.id === s.payer ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select>') +
      field('Recipient', '<select class="input" id="esRecip">' + S.members.map((m) => '<option value="' + m.id + '"' + (m.id === s.recipient ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select>') +
      field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="esAmt" value="' + Number(s.amount) + '"')) +
      field('Date', input('', 'type="date" id="esDate" value="' + s.settled_on.slice(0, 10) + '"')) +
      field('Notes', input('', 'id="esNotes" value="' + (s.notes ? esc(s.notes) : '') + '"')),
      async (dlg) => {
        const r = await api('/settlements/' + s.id, { method: 'PATCH', body: {
          payer: $('#esPayer', dlg).value, recipient: $('#esRecip', dlg).value,
          amount: Number($('#esAmt', dlg).value), settled_on: $('#esDate', dlg).value, notes: $('#esNotes', dlg).value } });
        toastUndo('Payment updated.', r.activity_id);
      });
  }));
  view().querySelectorAll('.st-del').forEach((el) => (el.onclick = () => {
    const s = hist.find((x) => x.id === el.dataset.id);
    confirmDialog('Delete this payment record (' + fmt(s.amount) + ')?', async () => {
      const r = await api('/settlements/' + s.id, { method: 'DELETE' });
      toastUndo('Payment deleted.', r.activity_id);
    });
  }));
}

// ---------- more ----------
async function renderMore() {
  if (S.moreView === 'members') return renderMembers();
  if (S.moreView === 'fibre') return renderFibre();
  if (S.moreView === 'reports') return renderReports();
  if (S.moreView === 'activity') return renderActivity();
  if (S.moreView === 'export') return renderExport();
  const prepaid = await api('/prepaid');
  const items = [
    ['members', 'Household members', 'Names, weekly rent, active status'],
    ['fibre', 'Fibre prepaid', fmt(prepaid.balance) + ' remaining'],
    ['reports', 'Reports', 'Category, weekly & monthly spending'],
    ['activity', 'Activity & undo', 'Recent changes, with undo'],
    ['export', 'Export to spreadsheet', 'Expenses, settlements and rent as CSV'],
  ];
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' +
    items.map(([id, label, sub]) =>
      '<button class="card blueprint more-i" data-id="' + id + '" style="flex-direction:row;align-items:center;gap:12px;cursor:pointer;width:100%;text-align:left;font:inherit;color:inherit;min-height:56px;">' +
      '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
      '<div style="flex:1;"><div class="cc-num" style="font-size:16px;">' + label + '</div>' +
      '<div class="text-muted" style="font-size:12px;">' + sub + '</div></div><span style="opacity:.5;">\u203a</span></button>').join('') +
    '<button class="btn btn-secondary btn-block" id="pwBtn" style="min-height:44px;">Change password</button>' +
    (S.me.is_admin ? '<button class="btn btn-secondary btn-block" id="resetBtn" style="min-height:44px;">Reset demo data</button>' : '') +
    '<button class="btn btn-ghost btn-block" id="outBtn" style="min-height:44px;">Sign out</button></div>';
  view().querySelectorAll('.more-i').forEach((el) => (el.onclick = () => { S.moreView = el.dataset.id; render(); }));
  $('#pwBtn').onclick = () => dialog('Change password',
    field('Current password', input('', 'type="password" id="pwCur"')) +
    field('New password (8+ characters)', input('', 'type="password" id="pwNew"')),
    async (dlg) => {
      await api('/auth/change-password', { method: 'POST', body: { current: $('#pwCur', dlg).value, next: $('#pwNew', dlg).value } });
      toast('Password changed.');
    });
  const rb = $('#resetBtn');
  if (rb) rb.onclick = () => confirmDialog('Remove all demo data (dummy expenses, bills, settlements, fibre history and past rent weeks)? Anything real you\u2019ve entered stays.', async () => {
    const r = await api('/admin/reset-demo', { method: 'POST' });
    toast(r.message);
  });
  $('#outBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); S.me = null; renderLogin(); };
}
const backBtn = '<button class="btn btn-ghost" id="backM" style="align-self:flex-start;min-height:40px;">\u2190 More</button>';
function wireBack() { $('#backM').onclick = () => { S.moreView = 'menu'; render(); }; }
async function renderMembers() {
  const members = await api('/members');
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' + backBtn +
    '<h4 style="margin:0;">Household members</h4>' +
    members.map((m) => card(
      '<div class="cc-avatar">' + esc(m.initials) + '</div>' +
      input('m-name', 'value="' + esc(m.name) + '" data-id="' + m.id + '" style="flex:1;"') +
      '<div style="display:flex;align-items:center;gap:4px;"><span class="text-muted" style="font-size:13px;">$</span>' +
      input('m-rent', 'type="number" value="' + Number(m.weekly_rent) + '" data-id="' + m.id + '" style="width:74px;"') +
      '<span class="text-muted" style="font-size:12px;">/wk</span></div>',
      'flex-direction:row;align-items:center;gap:12px;')).join('') +
    '<div class="card-meta">Weekly household rent: ' + fmt(members.reduce((s, m) => s + Number(m.weekly_rent), 0)) + ' \u00b7 changes apply from the current week</div></div>';
  wireBack();
  const save = async (el, body) => {
    try { await api('/members/' + el.dataset.id, { method: 'PATCH', body }); toast('Saved.'); }
    catch (e) { toast(e.message); }
  };
  view().querySelectorAll('.m-name').forEach((el) => (el.onchange = () => save(el, { name: el.value })));
  view().querySelectorAll('.m-rent').forEach((el) => (el.onchange = () => save(el, { weekly_rent: Number(el.value) })));
}
async function renderFibre() {
  const p = await api('/prepaid');
  const pct = Math.max(2, Math.min(100, (p.balance / Math.max(p.total_topped_up, 1)) * 100)).toFixed(0);
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' + backBtn +
    '<h4 style="margin:0;">Fibre prepaid</h4>' +
    card('<div class="card-kicker">Remaining balance</div>' +
      '<div class="cc-num" style="font-size:38px;line-height:1;">' + fmt(p.balance) + '</div>' +
      '<div class="text-muted" style="font-size:12px;">~' + fmt(p.avg_weekly_usage) + '/week \u00b7 runs out around ' + shortDate(p.est_depletion_date) + '</div>' +
      '<div class="cc-bar" style="margin-top:8px;"><div style="width:' + pct + '%;"></div></div>' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;" class="text-muted"><span>Topped up ' + fmt(p.total_topped_up) + '</span><span>Used ' + fmt(p.total_used) + '</span></div>',
      'text-align:center;padding:18px;gap:4px;') +
    '<div style="display:flex;gap:8px;">' + input('', 'type="number" placeholder="Top-up amount" id="tAmt" style="flex:1;"') +
    '<button class="btn btn-primary" id="tGo" style="min-height:44px;">Record top-up</button></div>' +
    '<div style="display:flex;gap:8px;">' + input('', 'type="number" placeholder="Usage amount" id="uAmt" style="flex:1;"') +
    '<button class="btn btn-secondary" id="uGo" style="min-height:44px;">Record usage</button></div>' +
    field('Cost allocation', '<div class="seg" id="alloc">' +
      [['equal', 'Equal'], ['percent', 'Custom %'], ['custom', 'Fixed $']].map(([v, l]) =>
        '<label class="seg-opt" style="min-height:40px;"><input type="radio" name="al" value="' + v + '"' + (p.allocation_method === v ? ' checked' : '') + '>' + l + '</label>').join('') + '</div>') +
    card('<div class="card-kicker" style="margin-bottom:4px;">Top-ups &amp; usage</div>' +
      [].concat(
        p.topups.map((t) => ({ type: 'topup', id: t.id, d: t.topup_date.slice(0, 10), h: 'Top-up by ' + esc(t.paid_by_name), a: '+' + fmt(t.amount), c: 'cc-pos', raw: t })),
        p.usage.map((u) => ({ type: 'usage', id: u.id, d: u.usage_date.slice(0, 10), h: esc(u.note || 'Usage'), a: '\u2212' + fmt(u.amount), c: '', raw: u })))
        .sort((a, b) => b.d.localeCompare(a.d))
        .map((r) => '<div class="cc-row" style="padding:8px 0;font-size:13px;"><div style="flex:1;">' + r.h +
          ' <span class="text-muted">\u00b7 ' + shortDate(r.d) + '</span></div><div class="cc-num ' + r.c + '">' + r.a + '</div>' +
          iconBtn('pp-edit', r.type + ':' + r.id, PENCIL, 'Edit') + iconBtn('pp-del', r.type + ':' + r.id, TRASH, 'Delete') + '</div>').join(''), 'gap:0;') + '</div>';
  wireBack();
  $('#tGo').onclick = async () => {
    try { const r = await api('/prepaid/topups', { method: 'POST', body: { amount: Number($('#tAmt').value) } }); toastUndo('Top-up recorded.', r.activity_id); render(); }
    catch (e) { toast(e.message); }
  };
  $('#uGo').onclick = async () => {
    try { const r = await api('/prepaid/usage', { method: 'POST', body: { amount: Number($('#uAmt').value) } }); toastUndo('Usage recorded.', r.activity_id); render(); }
    catch (e) { toast(e.message); }
  };
  view().querySelectorAll('input[name=al]').forEach((r) => (r.onchange = async () => {
    try { await api('/prepaid/allocation', { method: 'PUT', body: { method: r.value } }); toast('Allocation updated.'); }
    catch (e) { toast(e.message); }
  }));
  view().querySelectorAll('.pp-edit').forEach((el) => (el.onclick = () => {
    const [type, id] = el.dataset.id.split(':');
    const row = (type === 'topup' ? p.topups : p.usage).find((x) => x.id === id);
    if (type === 'topup') {
      dialog('Edit top-up',
        field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="ptAmt" value="' + Number(row.amount) + '"')) +
        field('Date', input('', 'type="date" id="ptDate" value="' + row.topup_date.slice(0, 10) + '"')),
        async (dlg) => {
          const r = await api('/prepaid/topups/' + id, { method: 'PATCH', body: { amount: Number($('#ptAmt', dlg).value), topup_date: $('#ptDate', dlg).value } });
          toastUndo('Top-up updated.', r.activity_id);
        });
    } else {
      dialog('Edit usage',
        field('Amount (NZD)', input('', 'type="number" inputmode="decimal" id="puAmt" value="' + Number(row.amount) + '"')) +
        field('Date', input('', 'type="date" id="puDate" value="' + row.usage_date.slice(0, 10) + '"')) +
        field('Note', input('', 'id="puNote" value="' + (row.note ? esc(row.note) : '') + '"')),
        async (dlg) => {
          const r = await api('/prepaid/usage/' + id, { method: 'PATCH', body: { amount: Number($('#puAmt', dlg).value), usage_date: $('#puDate', dlg).value, note: $('#puNote', dlg).value } });
          toastUndo('Usage updated.', r.activity_id);
        });
    }
  }));
  view().querySelectorAll('.pp-del').forEach((el) => (el.onclick = () => {
    const [type, id] = el.dataset.id.split(':');
    confirmDialog('Delete this ' + (type === 'topup' ? 'top-up' : 'usage record') + '?', async () => {
      const r = await api('/prepaid/' + (type === 'topup' ? 'topups' : 'usage') + '/' + id, { method: 'DELETE' });
      toastUndo((type === 'topup' ? 'Top-up' : 'Usage') + ' deleted.', r.activity_id);
    });
  }));
}
async function renderReports() {
  const [cats, weekly, byMember] = await Promise.all([
    api('/reports/categories'), api('/reports/weekly?weeks=9'), api('/reports/by-member'),
  ]);
  const catRows = cats.categories.map((c) => ({ label: c.name, v: Number(c.total) }));
  if (cats.rent_collected) catRows.unshift({ label: 'Rent (collected)', v: cats.rent_collected });
  catRows.sort((a, b) => b.v - a.v);
  const maxC = Math.max(...catRows.map((c) => c.v), 1);
  const maxW = Math.max(...weekly.map((w) => w.total), 1);
  const maxM = Math.max(...byMember.map((m) => Number(m.total)), 1);
  const bars = (rows) => rows.map((r) =>
    '<div><div style="display:flex;justify-content:space-between;font-size:12px;"><span>' + esc(r.label) + '</span><span class="cc-num">' + fmt(r.v) + '</span></div>' +
    '<div class="cc-bar" style="margin-top:2px;"><div style="width:' + ((r.v / r.max) * 100).toFixed(0) + '%;"></div></div></div>').join('');
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' + backBtn +
    '<h4 style="margin:0;">Reports</h4>' +
    card('<div class="card-kicker">Spending by category \u2014 all time</div>' + bars(catRows.map((c) => ({ ...c, max: maxC }))), 'gap:8px;') +
    card('<div class="card-kicker">Weekly spending (excl. rent)</div>' +
      '<div style="display:flex;align-items:flex-end;gap:6px;height:110px;">' +
      weekly.map((w, i) => '<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%;">' +
        '<div class="text-muted" style="font-size:9px;">$' + Math.round(w.total) + '</div>' +
        '<div style="width:100%;border:1px solid var(--color-accent-600);background:' + (i === weekly.length - 1 ? 'var(--color-accent)' : 'var(--color-accent-200)') + ';height:' + Math.max(3, (w.total / maxW) * 100).toFixed(0) + '%;"></div>' +
        '<div class="text-muted" style="font-size:9px;">' + shortDate(w.week_start).replace(' ', '/') + '</div></div>').join('') + '</div>', 'gap:8px;') +
    card('<div class="card-kicker">Paid by flatmate \u2014 all time</div>' +
      bars(byMember.map((m) => ({ label: m.name, v: Number(m.total), max: maxM }))), 'gap:8px;') + '</div>';
  wireBack();
}
async function renderExport() {
  const files = [['expenses', 'Expenses', 'every expense, with each person’s share'],
    ['settlements', 'Settlements', 'who paid who back'], ['rent', 'Rent', 'due and paid, per person per week']];
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' + backBtn +
    '<h4 style="margin:0;">Export to spreadsheet</h4>' +
    '<div class="card-meta">CSV files open in Excel, Google Sheets or Numbers. Leave the dates empty for everything.</div>' +
    card('<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:140px;">' + field('From', input('', 'type="date" id="exFrom"')) + '</div>' +
      '<div style="flex:1;min-width:140px;">' + field('To (inclusive)', input('', 'type="date" id="exTo"')) + '</div></div>', 'gap:8px;') +
    files.map(([id, label, sub]) => '<a class="btn btn-secondary btn-block ex-link" data-id="' + id + '" download ' +
      'style="min-height:52px;display:flex;flex-direction:column;justify-content:center;text-decoration:none;">' +
      '<span>Download ' + label + ' (.csv)</span><span class="text-muted" style="font-size:11px;">' + sub + '</span></a>').join('') + '</div>';
  wireBack();
  const update = () => {
    const qs = new URLSearchParams();
    if ($('#exFrom').value) qs.set('from', $('#exFrom').value);
    if ($('#exTo').value) qs.set('to', $('#exTo').value);
    view().querySelectorAll('.ex-link').forEach((a) => (a.href = '/api/export/' + a.dataset.id + '.csv' + (qs.size ? '?' + qs : '')));
  };
  $('#exFrom').onchange = update; $('#exTo').onchange = update; update();
}
async function renderActivity() {
  const rows = await api('/activity?limit=40');
  view().innerHTML = '<div style="display:flex;flex-direction:column;gap:16px;">' + backBtn +
    '<h4 style="margin:0;">Activity &amp; undo</h4>' +
    '<div class="card-meta">Recent changes across the household. Undo reverses that single change \u2014 it won\u2019t undo anything done after it.</div>' +
    card((rows.length ? rows.map((r) => '<div class="cc-row" style="padding:9px 0;font-size:13px;gap:8px;">' +
      '<div style="flex:1;' + (r.undone ? 'opacity:.5;text-decoration:line-through;' : '') + '">' + esc(r.summary) +
      ' <span class="text-muted">\u00b7 ' + esc(r.user_name || 'someone') + ' \u00b7 ' + new Date(r.created_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</span></div>' +
      (r.undone ? '<span class="tag tag-neutral" style="font-size:10px;">undone</span>' :
        '<button class="btn btn-ghost act-undo" data-id="' + r.id + '" style="min-height:32px;font-size:12px;">Undo</button>') +
      '</div>').join('') : '<div class="text-muted" style="font-size:13px;">No activity yet.</div>'), 'gap:0;') + '</div>';
  wireBack();
  view().querySelectorAll('.act-undo').forEach((el) => (el.onclick = () => {
    confirmUndo(el.dataset.id);
  }));
}
function confirmUndo(activityId) {
  const bd = document.createElement('div');
  bd.className = 'dialog-backdrop'; bd.style.zIndex = 70;
  bd.innerHTML = '<div class="dialog blueprint" style="max-width:340px;"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
    '<div class="dialog-title">Undo this action?</div><div class="dlg-body">This reverses that specific change and updates balances immediately.</div>' +
    '<div class="dialog-actions"><button class="btn btn-secondary u-no" style="min-height:44px;">Cancel</button>' +
    '<button class="btn btn-primary u-yes" style="min-height:44px;">Undo</button></div></div>';
  bd.addEventListener('click', (e) => { if (e.target === bd) bd.remove(); });
  $('.u-no', bd).onclick = () => bd.remove();
  $('.u-yes', bd).onclick = async () => {
    try { await api('/activity/' + activityId + '/undo', { method: 'POST' }); bd.remove(); toast('Undone.'); render(); }
    catch (e) { toast(e.message || 'Could not undo that.'); }
  };
  document.body.appendChild(bd);
}

// ---------- router ----------
async function render() {
  if (!S.me) return renderLogin();
  shell(spinner);
  try {
    if (S.tab === 'dash') await renderDash();
    else if (S.tab === 'expenses') await renderExpenses();
    else if (S.tab === 'bills') await renderBills();
    else if (S.tab === 'balances') await renderBalances();
    else await renderMore();
  } catch (e) {
    if (e.code === 'UNAUTHENTICATED') { S.me = null; return renderLogin(); }
    view().innerHTML = '<div class="text-muted" style="padding:32px;text-align:center;">' + esc(e.message || 'Something went wrong.') + '</div>';
  }
}
async function boot() {
  try {
    const [me, members, categories] = await Promise.all([api('/me'), api('/members'), api('/categories')]);
    S.me = me; S.members = members.filter((m) => m.active); S.categories = categories;
    render();
  } catch (e) { renderLogin(); }
}
boot();
})();
