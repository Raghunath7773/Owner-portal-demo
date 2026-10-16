import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUS = {
  SUPPORT: 'Waiting for Support',
  OWNER: 'Waiting for Owner',
  RESOLVED: 'Resolved',
};
const CATEGORIES = ['Income', 'Expenses', 'Payments', 'Statements', 'Property', 'Other'];

// Static demo data, matching the portal design.
const SEED = [
  { id: 'OWN-1042', subject: 'Clarification on September maintenance charge', property: 'Palm Haven · Villa 04', category: 'Expenses', status: STATUS.SUPPORT, messages: 3, createdAt: '2026-10-02T09:12:00Z' },
  { id: 'OWN-1041', subject: 'When will my October payout arrive?', property: 'Palm Haven · Villa 04', category: 'Payments', status: STATUS.RESOLVED, messages: 2, createdAt: '2026-09-29T14:40:00Z' },
  { id: 'OWN-1038', subject: 'Request for the latest property inspection', property: 'Oceanview · Suite 12', category: 'Property', status: STATUS.OWNER, messages: 2, createdAt: '2026-09-20T11:05:00Z' },
  { id: 'OWN-1035', subject: 'September rental income breakdown', property: 'Palm Haven · Villa 04', category: 'Income', status: STATUS.RESOLVED, messages: 2, createdAt: '2026-09-12T08:30:00Z' },
];

/**
 * Queries kept in one JSON file.
 * shortcut: a file on local disk is wiped on Render redeploys (free tier); use a database or a Render disk to keep queries.
 */
export function createQueryStore(file) {
  let queries = [];
  try {
    queries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : structuredClone(SEED);
  } catch {
    queries = structuredClone(SEED);
  }

  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(queries, null, 2));
    } catch (err) {
      console.warn('[queries] could not persist:', err.message); // keep serving from memory
    }
  };

  const newId = () => {
    let id;
    do id = `OWN-${Math.floor(1000 + Math.random() * 9000)}`;
    while (queries.some((q) => q.id === id));
    return id;
  };

  return {
    list: () => [...queries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

    create(input) {
      const subject = String(input?.subject ?? '').trim().slice(0, 140);
      if (!subject) throw Object.assign(new Error('subject is required'), { status: 400 });
      const query = {
        id: newId(),
        subject,
        description: String(input?.description ?? '').trim().slice(0, 2000),
        property: String(input?.property ?? '').trim().slice(0, 120) || 'All properties',
        category: CATEGORIES.includes(input?.category) ? input.category : 'Other',
        status: STATUS.SUPPORT,
        messages: 1,
        source: input?.source === 'assistant' ? 'assistant' : 'portal',
        createdAt: new Date().toISOString(),
      };
      queries.push(query);
      save();
      return query;
    },

    stats() {
      const count = (s) => queries.filter((q) => q.status === s).length;
      return {
        total: queries.length,
        awaitingSupport: count(STATUS.SUPPORT),
        awaitingOwner: count(STATUS.OWNER),
        resolved: count(STATUS.RESOLVED),
      };
    },
  };
}
