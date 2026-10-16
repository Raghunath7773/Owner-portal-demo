import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryStore, STATUS } from './queries.js';

test('new queries get a unique OWN- id, wait for support and show up first', () => {
  const store = createQueryStore(join(tmpdir(), `queries-${Date.now()}.json`));
  const before = store.stats();
  const q = store.create({ subject: 'September settlement looks wrong', category: 'Statements', source: 'assistant' });

  assert.match(q.id, /^OWN-\d{4}$/);
  assert.equal(q.status, STATUS.SUPPORT);
  assert.equal(store.list()[0].id, q.id);
  assert.equal(store.stats().total, before.total + 1);
  assert.equal(store.stats().awaitingSupport, before.awaitingSupport + 1);
  assert.notEqual(store.create({ subject: 'Second' }).id, q.id);
});

test('subject is required and unknown categories fall back to Other', () => {
  const store = createQueryStore(join(tmpdir(), `queries-${Date.now()}-2.json`));
  assert.throws(() => store.create({ subject: '  ' }), /subject is required/);
  assert.equal(store.create({ subject: 'x', category: 'Hack' }).category, 'Other');
});
