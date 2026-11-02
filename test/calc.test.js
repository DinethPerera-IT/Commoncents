// Unit tests for the money math in server/calc.js (node:test, no extra dependencies).
// Amounts are compared in whole cents so floating-point noise can't hide a real error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round2, equalSplit, percentSplit, validateSplits, netBalances, settlementPlan, topupShares,
  weekStartOf, addDays, today, nearestMonday, statement,
} from '../server/calc.js';

const cents = (n) => Math.round(n * 100);
const sumCents = (obj) => Object.values(obj).reduce((s, v) => s + cents(v), 0);
const ids = (n) => Array.from({ length: n }, (_, i) => 'u' + i);
const users = ids(4).map((id) => ({ id, active: true }));

test('round2 rounds half-cents up, including the float traps', () => {
  assert.equal(round2(1.005), 1.01);   // 1.005 is stored as 1.00499999…
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(10.125), 10.13);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(33.333333), 33.33);
});

test('equalSplit: $100 / 3 adds up to exactly $100', () => {
  const s = equalSplit(100, ids(3));
  assert.equal(sumCents(s), 10000);
  assert.deepEqual(Object.values(s).map(cents).sort(), [3333, 3333, 3334]);
});

test('equalSplit: every amount from 1c to $50 among 1–6 people sums exactly and is fair to 1c', () => {
  for (let n = 1; n <= 6; n++) {
    for (let c = 1; c <= 5000; c++) {
      const s = equalSplit(c / 100, ids(n));
      const v = Object.values(s).map(cents);
      assert.equal(v.reduce((a, b) => a + b, 0), c, `$${c / 100} / ${n}: sum ${v}`);
      assert.ok(Math.min(...v) >= 0, `$${c / 100} / ${n}: negative share ${v}`);
      assert.ok(Math.max(...v) - Math.min(...v) <= 1, `$${c / 100} / ${n}: unfair ${v}`);
    }
  }
});

test('validateSplits: custom and percent edge cases', () => {
  assert.equal(validateSplits('equal', 10, []), 'MISSING_FIELD:splits');
  assert.equal(validateSplits('custom', 10, [{ share_amount: 5 }, { share_amount: 5 }]), null);
  assert.equal(validateSplits('custom', 10, [{ share_amount: 5 }, { share_amount: 4.98 }]), 'SPLIT_MISMATCH');
  assert.equal(validateSplits('custom', 10, [{ share_amount: 5 }, { share_amount: 4.99 }]), 'SPLIT_MISMATCH'); // 1c off is still off
  assert.equal(validateSplits('custom', 0.3, [{ share_amount: 0.1 }, { share_amount: 0.2 }]), null); // 0.1+0.2 float
  assert.equal(validateSplits('percent', 10, [{ share_percent: 33.33 }, { share_percent: 33.33 }, { share_percent: 33.34 }]), null);
  assert.equal(validateSplits('percent', 10, [{ share_percent: 50 }, { share_percent: 49 }]), 'PERCENT_MISMATCH');
  assert.equal(validateSplits('custom', 10, [{ share_amount: 'abc' }, { share_amount: 10 }]), null); // non-numbers count as 0
});

function ledger() {
  const [a, b, c, d] = ids(4);
  const expenses = [
    { id: 'e1', is_shared: true, paid_by: a, amount: '100.00' },
    { id: 'e2', is_shared: true, paid_by: b, amount: '45.55' },
    { id: 'e3', is_shared: false, paid_by: c, amount: '999.00' },   // not shared: ignored
  ];
  const splits = [
    ...Object.entries(equalSplit(100, ids(4))).map(([user_id, share_amount]) => ({ expense_id: 'e1', user_id, share_amount })),
    ...Object.entries(equalSplit(45.55, [a, b, c])).map(([user_id, share_amount]) => ({ expense_id: 'e2', user_id, share_amount })),
  ];
  const topups = [{ paid_by: d, amount: '250.00' }];
  const settlements = [
    { payer: c, recipient: a, amount: '20.00', status: 'done' },
    { payer: c, recipient: b, amount: '500.00', status: 'cancelled' },   // not done: ignored
  ];
  return { users, expenses, splits, topups, allocations: [], allocationMethod: 'equal', settlements };
}

test('netBalances: balances always sum to zero', () => {
  const net = netBalances(ledger());
  assert.equal(sumCents(net), 0, JSON.stringify(net));
});

test('netBalances: values for a known ledger', () => {
  const net = netBalances(ledger());
  // a: +100 − 25 − 15.18 (e2) − 62.50 (fibre) + 20 settlement paid TO a ⇒ recipient side −20
  assert.deepEqual(Object.fromEntries(Object.entries(net).map(([k, v]) => [k, cents(v)])),
    { u0: 100_00 - 25_00 - 15_18 - 62_50 - 20_00, u1: 45_55 - 25_00 - 15_18 - 62_50,
      u2: -25_00 - 15_19 - 62_50 + 20_00, u3: 250_00 - 25_00 - 62_50 });
});

test('topupShares: equal / percent / custom', () => {
  assert.equal(sumCents(topupShares(250, users, 'equal', [])), 25000);
  const pct = topupShares(250, users, 'percent', users.map((u, i) => ({ user_id: u.id, percent: [25, 30, 20, 25][i] })));
  assert.deepEqual(Object.values(pct).map(cents), [6250, 7500, 5000, 6250]);
  const fixed = topupShares(100, users, 'custom', users.map((u) => ({ user_id: u.id, fixed_amount: '25' })));
  assert.equal(sumCents(fixed), 10000);
  const withInactive = topupShares(90, [...users.slice(0, 3), { id: 'gone', active: false }], 'equal', []);
  assert.deepEqual(Object.keys(withInactive), ['u0', 'u1', 'u2']);   // inactive members pay nothing
});

function applyPlan(net, plan) {
  const after = Object.fromEntries(Object.entries(net).map(([k, v]) => [k, cents(v)]));
  for (const p of plan) { after[p.from] += cents(p.amount); after[p.to] -= cents(p.amount); }
  return after;
}

test('settlementPlan: clears every debt, no self-payments, at most n−1 payments', () => {
  const cases = [
    netBalances(ledger()),
    { a: 10, b: -10 },
    { a: 33.33, b: 33.33, c: 33.34, d: -100 },
    { a: -0.01, b: 0.01 },
    { a: 0, b: 0, c: 0 },
  ];
  for (const net of cases) {
    const plan = settlementPlan(net);
    assert.ok(plan.length <= Math.max(0, Object.keys(net).length - 1), JSON.stringify(plan));
    for (const p of plan) {
      assert.notEqual(p.from, p.to);
      assert.ok(p.amount > 0);
    }
    for (const [k, v] of Object.entries(applyPlan(net, plan))) assert.equal(v, 0, `${k} left with ${v}c in ${JSON.stringify(net)}`);
  }
});

test('settlementPlan: random ledgers always settle to the cent', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 2000; run++) {
    const n = 2 + Math.floor(rand() * 5);
    const vals = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 50000) / 100);
    vals.push(-vals.reduce((s, v) => s + cents(v), 0) / 100);
    const net = Object.fromEntries(vals.map((v, i) => ['m' + i, v]));
    const after = applyPlan(net, settlementPlan(net));
    for (const v of Object.values(after)) assert.equal(v, 0, JSON.stringify({ net, after }));
  }
});

test('weekStartOf: Monday-based weeks, across month and year ends', () => {
  assert.equal(weekStartOf('2026-11-02'), '2026-11-02');   // Monday
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02');   // Sunday
  assert.equal(weekStartOf('2026-11-09'), '2026-11-09');
  assert.equal(weekStartOf('2027-01-01'), '2026-12-28');   // Friday after a year end
  assert.equal(weekStartOf('2028-03-01'), '2028-02-28');   // leap year
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test("today() is the household's date (NZ), not the server's UTC date", () => {
  // Monday 2 Nov 2026, 09:30 in Auckland (NZDT, UTC+13) = Sunday 20:30 UTC.
  assert.equal(today(new Date('2026-11-01T20:30:00Z')), '2026-11-02');
  assert.equal(weekStartOf(today(new Date('2026-11-01T20:30:00Z'))), '2026-11-02');
  // Sunday 8 Nov, 23:59 in Auckland = Sunday 10:59 UTC: still the old week.
  assert.equal(today(new Date('2026-11-08T10:59:00Z')), '2026-11-08');
  // Winter (NZST, UTC+12): Monday 6 Jul 2026, 08:00 = Sunday 20:00 UTC.
  assert.equal(today(new Date('2026-07-05T20:00:00Z')), '2026-07-06');
});

test('percentSplit: shares add up to the amount exactly', () => {
  const pct = (...p) => p.map((share_percent, i) => ({ user_id: 'u' + i, share_percent }));
  assert.deepEqual(percentSplit(10, pct(33.33, 33.33, 33.34)).map((s) => cents(s.share_amount)), [333, 333, 334]);
  assert.deepEqual(percentSplit(145.6, pct(25, 30, 20, 25)).map((s) => cents(s.share_amount)), [3640, 4368, 2912, 3640]);
  for (let c = 1; c <= 3000; c++) {
    for (const p of [pct(33.33, 33.33, 33.34), pct(25, 30, 20, 25), pct(12.5, 87.5), pct(100)]) {
      const sum = percentSplit(c / 100, p).reduce((a, s) => a + cents(s.share_amount), 0);
      assert.equal(sum, c, `$${c / 100} at ${p.map((x) => x.share_percent)}`);
    }
  }
});

test('nearestMonday: old clients sent the Saturday/Sunday before the week; snap to that Monday', () => {
  assert.equal(nearestMonday('2026-10-24'), '2026-10-26');   // Sat → the week the user was looking at
  assert.equal(nearestMonday('2026-10-25'), '2026-10-26');   // Sun
  assert.equal(nearestMonday('2026-10-26'), '2026-10-26');   // Mon stays
  assert.equal(nearestMonday('2026-10-28'), '2026-10-26');   // Wed
});

test('browser date helpers give the same answers in any time zone', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const helpers = src.slice(src.indexOf('const pad2'), src.indexOf('const addDays')) +
    src.slice(src.indexOf('const addDays')).split('\n')[0];
  const { execFileSync } = await import('node:child_process');
  for (const tz of ['Pacific/Auckland', 'UTC', 'America/Los_Angeles']) {
    const out = execFileSync(process.execPath, ['-e', helpers +
      "; console.log(weekStartOf('2026-11-02'), weekStartOf('2026-11-08'), addDays('2026-11-02', 7), addDays('2026-11-02', 0))"],
      { env: { ...process.env, TZ: tz } }).toString().trim();
    assert.equal(out, '2026-11-02 2026-11-02 2026-11-09 2026-11-02', tz);
  }
});

// ---- statements --------------------------------------------------------------------------
function datedLedger() {
  const l = ledger();
  l.expenses.forEach((e, i) => (e.date = '2026-10-0' + (i + 1)));
  l.expenses.forEach((e) => (e.description = 'expense ' + e.id));
  l.topups.forEach((t) => (t.date = '2026-10-05'));
  l.settlements.forEach((s, i) => { s.date = '2026-10-1' + i; s.id = 's' + i; s.method = 'bank_transfer'; });
  return l;
}

test('statement: every member’s closing balance equals netBalances, to the cent', () => {
  const l = datedLedger();
  const net = netBalances(l);
  for (const u of l.users) {
    const st = statement(u.id, l);
    assert.equal(cents(st.closing), cents(net[u.id]), u.id);
    assert.equal(st.opening, 0);
    assert.equal(cents(st.entries.at(-1)?.balance ?? 0), cents(net[u.id]), u.id);
  }
});

test('statement: a date range turns earlier items into the opening balance', () => {
  const l = datedLedger();
  const full = statement('u0', l);
  const part = statement('u0', l, { from: '2026-10-03', to: '2026-10-10' });
  assert.ok(part.entries.every((e) => e.date >= '2026-10-03' && e.date <= '2026-10-10'));
  const before = full.entries.filter((e) => e.date < '2026-10-03').reduce((s, e) => s + cents(e.amount), 0);
  assert.equal(cents(part.opening), before);
  assert.equal(cents(part.closing), before + part.entries.reduce((s, e) => s + cents(e.amount), 0));
});

test('statement: wording and signs from u0’s side', () => {
  const st = statement('u0', datedLedger());
  const e1 = st.entries.find((e) => e.id === 'e1');
  assert.deepEqual([e1.paid, e1.share, e1.amount, e1.note], [100, 25, 75, 'you paid $100.00, your share $25.00']);
  const got = st.entries.find((e) => e.kind === 'settlement');
  assert.deepEqual([got.text, got.amount], ['someone paid you', -20]);   // test users have no names
  assert.ok(!st.entries.some((e) => e.id === 'e3'));                 // not shared: not on the statement
});
