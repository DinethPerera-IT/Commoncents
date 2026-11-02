// Business calculations — ported from the design prototype (commoncents-data.js).
// Money is rounded via whole cents. n * 100 is not enough: 1.005 is stored as 1.00499999…,
// so Math.round(1.005 * 100) gives 100. Shifting the decimal point in the string form
// ('1.005e2' = 100.5) rounds the number as it was written. Halves round away from zero.
export function toCents(n) {
  const x = Math.abs(Number(n));
  const c = String(x).includes('e') ? Math.round(x * 100) : Math.round(Number(x + 'e2'));
  return Number(n) < 0 ? -c : c;
}
export const round2 = (n) => toCents(n) / 100;

export function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
// The Monday a week URL means. Weeks always start on Monday, but older versions of the app
// sent the Saturday or Sunday before it (a browser time-zone bug), so snap to the nearest
// Monday: Sat/Sun → the following Monday, Tue–Thu → the Monday before.
export const nearestMonday = (dateStr) => weekStartOf(addDays(dateStr, 3));
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The household's calendar date. The server runs in UTC, and NZ is 12–13 h ahead, so a UTC
// date is "yesterday" every NZ morning (and Monday's new rent week started at 1 pm).
export const TIME_ZONE = process.env.APP_TZ || 'Pacific/Auckland';
export const today = (now = new Date(), timeZone = TIME_ZONE) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const currentWeek = (now = new Date()) => weekStartOf(today(now));

// Split in whole cents: everyone gets the same base, and the leftover cents (fewer than the
// number of people) go one each to the last people in the list. Shares always add up to the
// amount and never differ by more than 1c. ($100 / 3 = 33.33, 33.33, 33.34.)
export function equalSplit(amount, ids) {
  const total = toCents(amount);
  const base = Math.floor(total / ids.length);
  const extra = total - base * ids.length;
  const shares = {};
  ids.forEach((id, i) => { shares[id] = (base + (i >= ids.length - extra ? 1 : 0)) / 100; });
  return shares;
}

// net[u] = paid-for-shared − own shares + topups paid − topup allocation ± settlements. Rent excluded.
export function netBalances({ users, expenses, splits, topups, allocations, allocationMethod, settlements }) {
  const net = {};
  users.forEach((u) => (net[u.id] = 0));
  const splitsByExpense = {};
  splits.forEach((s) => {
    (splitsByExpense[s.expense_id] ||= []).push(s);
  });
  expenses.forEach((e) => {
    if (!e.is_shared) return;
    net[e.paid_by] += Number(e.amount);
    (splitsByExpense[e.id] || []).forEach((s) => { net[s.user_id] -= Number(s.share_amount); });
  });
  topups.forEach((t) => {
    net[t.paid_by] += Number(t.amount);
    const shares = topupShares(Number(t.amount), users, allocationMethod, allocations);
    users.forEach((u) => { net[u.id] -= shares[u.id] || 0; });
  });
  settlements.forEach((s) => {
    if (s.status !== 'done') return;
    net[s.payer] += Number(s.amount);
    net[s.recipient] -= Number(s.amount);
  });
  Object.keys(net).forEach((k) => (net[k] = round2(net[k])));
  return net;
}

// One member's statement: every item that moved their balance, oldest first, with the same rules
// as netBalances (shared expenses, fibre top-ups, completed settlements; rent excluded), so the
// last running balance is always exactly their net balance. `amount` is the effect on the balance:
// + means the household owes them more, − means they owe more. Dates are 'YYYY-MM-DD'.
// from/to (inclusive, optional) limit the listed entries; earlier items become the opening balance.
export function statement(memberId, { users, expenses, splits, topups, allocations, allocationMethod, settlements }, { from, to } = {}) {
  const name = (id) => users.find((u) => u.id === id)?.name || 'someone';
  const items = [];
  const shareOf = {};
  splits.forEach((s) => { if (s.user_id === memberId) shareOf[s.expense_id] = toCents(s.share_amount); });
  expenses.forEach((e) => {
    if (!e.is_shared) return;
    const paid = e.paid_by === memberId ? toCents(e.amount) : 0;
    const share = shareOf[e.id] || 0;
    if (!paid && !share) return;
    items.push({ date: e.date, kind: 'expense', id: e.id, text: e.description, paid, share,
      note: paid ? 'you paid ' + fmtCents(paid) + (share ? ', your share ' + fmtCents(share) : '') : name(e.paid_by) + ' paid; your share' });
  });
  topups.forEach((t) => {
    const paid = t.paid_by === memberId ? toCents(t.amount) : 0;
    const share = toCents(topupShares(Number(t.amount), users, allocationMethod, allocations)[memberId] || 0);
    if (!paid && !share) return;
    items.push({ date: t.date, kind: 'topup', id: t.id, text: 'Fibre top-up', paid, share,
      note: paid ? 'you topped up ' + fmtCents(paid) + (share ? ', your share ' + fmtCents(share) : '') : name(t.paid_by) + ' topped up; your share' });
  });
  settlements.forEach((s) => {
    if (s.status !== 'done') return;
    if (s.payer === memberId) items.push({ date: s.date, kind: 'settlement', id: s.id, text: 'You paid ' + name(s.recipient), paid: toCents(s.amount), share: 0, note: methodText(s.method) });
    else if (s.recipient === memberId) items.push({ date: s.date, kind: 'settlement', id: s.id, text: name(s.payer) + ' paid you', paid: 0, share: toCents(s.amount), note: methodText(s.method) });
  });
  items.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  let opening = 0, running = 0;
  const entries = [];
  const totals = { paid: 0, share: 0 };
  for (const it of items) {
    const effect = it.paid - it.share;
    if (from && it.date < from) { opening += effect; running += effect; continue; }
    if (to && it.date > to) continue;
    running += effect;
    totals.paid += it.paid; totals.share += it.share;
    entries.push({ ...it, paid: it.paid / 100, share: it.share / 100, amount: effect / 100, balance: running / 100 });
  }
  return { opening: opening / 100, closing: running / 100, totals: { paid: totals.paid / 100, share: totals.share / 100 }, entries };
}
const fmtCents = (c) => '$' + (c / 100).toFixed(2);
const methodText = (m) => String(m || '').replace(/_/g, ' ');   // 'bank_transfer' → 'bank transfer'

export function topupShares(amount, users, method, allocations) {
  const active = users.filter((u) => u.active);
  if (method === 'percent' && allocations.length) {
    const out = {};
    allocations.forEach((a) => (out[a.user_id] = round2(amount * (Number(a.percent) || 0) / 100)));
    return out;
  }
  if (method === 'custom' && allocations.length) {
    const out = {};
    allocations.forEach((a) => (out[a.user_id] = Number(a.fixed_amount) || 0));
    return out;
  }
  return equalSplit(amount, active.map((u) => u.id));
}

// Greedy minimal settlement plan (≤ n−1 payments), in whole cents so even a 1c debt is settled.
export function settlementPlan(net) {
  const debtors = [], creditors = [];
  Object.entries(net).forEach(([id, v]) => {
    const c = toCents(v);
    if (c < 0) debtors.push({ id, amt: -c });
    else if (c > 0) creditors.push({ id, amt: c });
  });
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const plan = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    plan.push({ from: debtors[i].id, to: creditors[j].id, amount: pay / 100 });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return plan;
}

export function fibreStats(topups, usage) {
  const up = topups.reduce((s, t) => s + Number(t.amount), 0);
  const used = usage.reduce((s, u) => s + Number(u.amount), 0);
  const bal = round2(up - used);
  const weeks = usage.length || 1;
  const perWeek = used / weeks;
  const weeksLeft = perWeek > 0 ? bal / perWeek : 999;
  return { total_topped_up: round2(up), total_used: round2(used), balance: bal,
    avg_weekly_usage: round2(perWeek),
    est_depletion_date: addDays(currentWeek(), Math.min(3650, Math.round(weeksLeft * 7))) };
}

// Percent splits in whole cents: each person gets their percentage rounded down, then the
// leftover cents go to the largest remainders. Shares add up to the amount exactly
// ($10 at 33.33/33.33/33.34% = 3.33, 3.33, 3.34, not 3 × 3.33 = $9.99).
export function percentSplit(amount, splits) {
  const total = toCents(amount);
  const raw = splits.map((s) => (total * (Number(s.share_percent) || 0)) / 100);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]] += 1;
  return splits.map((s, i) => ({ ...s, share_amount: out[i] / 100 }));
}

export function validateSplits(method, amount, splits) {
  if (!splits || !splits.length) return 'MISSING_FIELD:splits';
  if (method === 'custom') {
    const sum = splits.reduce((s, x) => s + toCents(Number(x.share_amount) || 0), 0);
    if (sum !== toCents(amount)) return 'SPLIT_MISMATCH';   // exact to the cent, or balances drift
  }
  if (method === 'percent') {
    const sum = splits.reduce((s, x) => s + (Number(x.share_percent) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) return 'PERCENT_MISMATCH';
  }
  return null;
}
