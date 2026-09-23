// Business calculations — ported from the design prototype (commoncents-data.js).
export const round2 = (n) => Math.round(n * 100) / 100;

export function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const today = () => new Date().toISOString().slice(0, 10);
export const currentWeek = () => weekStartOf(today());

export function equalSplit(amount, ids) {
  const per = round2(amount / ids.length);
  const shares = {};
  ids.forEach((id, i) => {
    shares[id] = i === ids.length - 1 ? round2(amount - per * (ids.length - 1)) : per;
  });
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

// Greedy minimal settlement plan (≤ n−1 payments).
export function settlementPlan(net) {
  const debtors = [], creditors = [];
  Object.entries(net).forEach(([id, v]) => {
    if (v < -0.01) debtors.push({ id, amt: -v });
    else if (v > 0.01) creditors.push({ id, amt: v });
  });
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const plan = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    plan.push({ from: debtors[i].id, to: creditors[j].id, amount: round2(pay) });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt < 0.01) i++;
    if (creditors[j].amt < 0.01) j++;
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

export function validateSplits(method, amount, splits) {
  if (!splits || !splits.length) return 'MISSING_FIELD:splits';
  if (method === 'custom') {
    const sum = splits.reduce((s, x) => s + (Number(x.share_amount) || 0), 0);
    if (Math.abs(sum - amount) > 0.01) return 'SPLIT_MISMATCH';
  }
  if (method === 'percent') {
    const sum = splits.reduce((s, x) => s + (Number(x.share_percent) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) return 'PERCENT_MISMATCH';
  }
  return null;
}
