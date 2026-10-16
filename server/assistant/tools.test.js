import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, monthRange, settlementPayout } from './tools.js';

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
