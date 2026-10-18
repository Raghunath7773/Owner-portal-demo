import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, manualEntry, monthRange, monthTotals, settlementPayout } from './tools.js';

test('manual entries follow the ledger: income credits, expenses and payments debit (sign of ownerAmt ignored)', () => {
  assert.deepEqual(manualEntry({ type: 1, ownerAmt: '200' }), { kind: 'income', amount: 200 });
  assert.deepEqual(manualEntry({ type: 2, ownerAmt: '100' }), { kind: 'expense', amount: -100 });
  assert.deepEqual(manualEntry({ type: 3, ownerAmt: '-200' }), { kind: 'payment', amount: -200 });
});

test('month net_total matches the ledger: settlements + other income - expenses - payments', () => {
  const settlements = [{ date: '2026-09-03T10:00:00Z', owner_payout: 10606.56 }, { date: '2026-08-30T10:00:00Z', owner_payout: 500 }];
  const entries = [
    { date: '2026-09-03T00:00:00Z', ...manualEntry({ type: 2, ownerAmt: '100' }) },
    { date: '2026-09-25T00:00:00Z', ...manualEntry({ type: 2, ownerAmt: '100' }) },
    { date: '2026-09-03T11:18:36Z', ...manualEntry({ type: 3, ownerAmt: '-200' }) },
    { date: '2026-09-25T04:33:11Z', ...manualEntry({ type: 1, ownerAmt: '200' }) },
  ];
  const t = monthTotals('2026-09', settlements, entries);
  assert.equal(t.net_total, 10406.56);
  assert.deepEqual([t.settlement_income, t.other_income, t.expenses, t.payments], [10606.56, 200, 200, 200]);
  assert.equal(t.settlements.length, 1); // August settlement excluded
});

test('payout follows the Owner Financials rule: group share first, else the settlement total', () => {
  assert.equal(settlementPayout({ ownerfinancial: { owner_amount: 407.7 }, totalowneramount: 9999 }), 407.7);
  assert.equal(settlementPayout({ totalowneramount: '5223.00' }), 5223);
  assert.equal(settlementPayout({ totalowneramount: '-100.25' }), -100.25);
  assert.equal(settlementPayout({}), 0);
});

test('month range covers the whole month, including leap years', () => {
  assert.deepEqual(monthRange('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
});

test('compact strips personal fields and caps list length', () => {
  const out = compact({ guest_name: 'A', guestEmail: 'a@b.c', phone: '1', rows: Array.from({ length: 80 }, (_, i) => i) });
  assert.deepEqual(Object.keys(out), ['guest_name', 'rows']);
  assert.equal(out.rows.length, 60);
});
