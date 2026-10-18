import { Behavior, Type } from '@google/genai';
import { erpGet, query } from './data.js';

const MONTH = { type: Type.STRING, description: 'Month as YYYY-MM' };

// Read-only tools, always scoped to the configured owner in code — the model never chooses the owner.
export const TOOL_DECLARATIONS = [
  {
    name: 'get_income_summary',
    description:
      "The owner's money per month exactly as the Owner Financials ledger: settlement payouts plus other income, minus " +
      'expenses and payments (net_total), with every settlement and entry. Pass several months to compare them.',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { months: { type: Type.ARRAY, items: MONTH } }, required: ['months'] },
  },
  {
    name: 'get_month_breakdown',
    description:
      'Full breakdown of ONE month in a single call: every settlement with its payout, fee and line items ' +
      '(reservations/units, dates, amounts), plus the expenses, payments and other income entries, and net_total. ' +
      'Use for "break down my September income/statement".',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { month: MONTH }, required: ['month'] },
  },
  {
    name: 'get_settlements',
    description:
      "The owner's settlements/statements with date, status, owner payout and management fee (as in Owner Financials). " +
      'Optional month; without it, the last 6 months. Use to answer "how much was my settlement".',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { month: MONTH } },
  },
  {
    name: 'get_settlement_details',
    description:
      'Breakdown of ONE settlement for this owner: reservations/units, dates, owner amounts, management fees, expenses. ' +
      'Pass settlement_id from get_settlements.',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { settlement_id: { type: Type.INTEGER } }, required: ['settlement_id'] },
  },
  {
    name: 'get_owner_charges',
    description:
      'Expenses/charges billed to the owner (maintenance, repairs, supplies) with what they were for, supplier, amount and whether settled. ' +
      'Optional month and search text (e.g. "maintenance", "plumbing").',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { month: MONTH, search: { type: Type.STRING } } },
  },
  {
    name: 'get_maintenance_tasks',
    description:
      "Recent work on the owner's units (repairs, maintenance, cleaning) with status and completion date. " +
      'Use search for the item, e.g. "air conditioner" or "AC".',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: { search: { type: Type.STRING } } },
  },
  {
    name: 'raise_owner_query',
    description:
      'Raise a support query/ticket for the owner (wrong settlement, charge dispute, maintenance problem, anything for the team). ' +
      'Returns the ticket id to read back to the owner.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        subject: { type: Type.STRING, description: 'Short title, e.g. "September settlement looks wrong"' },
        description: { type: Type.STRING, description: "The owner's issue in their own words, with any amounts/dates mentioned" },
        category: { type: Type.STRING, enum: ['Income', 'Expenses', 'Payments', 'Statements', 'Property', 'Other'] },
        property: { type: Type.STRING, description: 'Property or unit name if the owner mentioned one' },
      },
      required: ['subject', 'description', 'category'],
    },
  },
];

// ── helpers (exported for tests) ─────────────────────────────────────────
const round2 = (n) => Math.round(n * 100) / 100;

/** Owner Financials ledger rule (ERP client calculations.ts): this owner's group share, else the settlement total. */
export const settlementPayout = (s) => round2(Number(s?.ownerfinancial?.owner_amount || s?.totalowneramount || 0));

export function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  return { from: `${m}-01`, to: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) };
}

/** Keeps API payloads small for the model and drops personal fields it never needs. */
export function compact(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => compact(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 5) return undefined;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !/email|phone|fcm|token|password|address|dob|tax|docs/i.test(k))
        .map(([k, x]) => [k, compact(x, depth + 1)]),
    );
  }
  return typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v;
}

/** Same request the Owner Financials tab makes for an owner, reduced to what the model needs. */
async function listSettlements(ctx, from, to) {
  const qs = new URLSearchParams({
    organization_id: String(ctx.orgId), user_id: ctx.ownerId, start_date: from, end_date: to, page: '1', limit: '1000',
  });
  const body = await erpGet(`/virtual-inspect/owner-settlement?${qs}`);
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.data) ? body.data.data : [];
  return rows
    .map((r) => ({
      settlement_id: r.id,
      name: r.settlement_name,
      date: r.createdAt,
      type: r.ownerfinancial ? 'group' : 'individual',
      owner_payout: settlementPayout(r),
      management_fee: round2(Number(r?.ownerfinancial?.pmc_amount ?? r.totalpmsamount ?? 0)),
      all_reservations_settled: r.settlement_status,
      settlement_of_month: r.settlement_of_month,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Owner Financials ledger rule for manual entries (calculations.ts): income is a credit, expense and payment are debits. */
export function manualEntry(e) {
  const amount = round2(Math.abs(Number(e.ownerAmt) || 0));
  const kind = e.type === 1 ? 'income' : e.type === 2 ? 'expense' : 'payment';
  return { kind, amount: kind === 'income' ? amount : -amount };
}

/** Manual income/expense/payment entries on the owner's units — the ledger's second source next to settlements. */
async function listManualEntries(ctx, from, to) {
  const units = await Promise.all(
    ctx.unitIds.map((uid) =>
      // Same request and the same "skip a unit that fails" behaviour as the ledger.
      erpGet(`/data-import/units/${uid}?startDate=${from}&endDate=${to}`).then((r) => r?.data ?? r).catch(() => null),
    ),
  );
  return units
    .flatMap((u) =>
      (u?.entries ?? [])
        .filter((e) => e.source === 'manual' && e.status === 'active')
        .map((e) => ({ entry_id: e.id, date: e.date, unit: u.unit_name, ...manualEntry(e), details: e.details || undefined })),
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** One month as the ledger shows it: settlements plus manual entries, and the net change. */
export function monthTotals(month, settlements, entries) {
  const s = settlements.filter((x) => String(x.date).startsWith(month));
  const e = entries.filter((x) => String(x.date).startsWith(month));
  const sum = (values) => round2(values.reduce((a, v) => a + v, 0));
  const totals = {
    settlement_income: sum(s.map((x) => x.owner_payout).filter((v) => v > 0)),
    settlement_debits: sum(s.map((x) => -x.owner_payout).filter((v) => v > 0)),
    other_income: sum(e.filter((x) => x.kind === 'income').map((x) => x.amount)),
    expenses: sum(e.filter((x) => x.kind === 'expense').map((x) => -x.amount)),
    payments: sum(e.filter((x) => x.kind === 'payment').map((x) => -x.amount)),
  };
  const net_total = round2(
    totals.settlement_income - totals.settlement_debits + totals.other_income - totals.expenses - totals.payments,
  );
  return { month, net_total, ...totals, settlements: s, entries: e };
}

const settlementDetails = (ctx, id) =>
  erpGet(`/virtual-inspect/owner-settlement/${id}?user_id=${encodeURIComponent(ctx.ownerId)}`).then(compact);

// ── execution ────────────────────────────────────────────────────────────
/** Runs one tool for the owner. Never throws: failures go back to the model as { error }. */
export async function executeTool(ctx, name, args, queries) {
  try {
    const month = /^\d{4}-\d{2}$/.test(args?.month ?? '') ? args.month : null;
    const like = args?.search ? `%${String(args.search).trim()}%` : null;

    switch (name) {
      case 'get_income_summary': {
        const months = [...new Set((Array.isArray(args.months) ? args.months : []).filter((m) => /^\d{4}-\d{2}$/.test(m)))]
          .sort()
          .slice(0, 6);
        if (!months.length) return { error: 'Give at least one month as YYYY-MM.' };
        const from = monthRange(months[0]).from;
        const to = monthRange(months.at(-1)).to;
        const [list, entries] = await Promise.all([listSettlements(ctx, from, to), listManualEntries(ctx, from, to)]);
        return {
          months: months.map((m) => monthTotals(m, list, entries)),
          note: 'Same as the Owner Financials ledger: net_total = settlement payouts + other income − expenses − payments.',
        };
      }

      case 'get_month_breakdown': {
        if (!month) return { error: 'Give the month as YYYY-MM.' };
        const range = monthRange(month);
        const [list, entries] = await Promise.all([
          listSettlements(ctx, range.from, range.to),
          listManualEntries(ctx, range.from, range.to),
        ]);
        // One tool call for the model; the details are fetched here in parallel.
        const details = await Promise.all(list.map((s) => settlementDetails(ctx, s.settlement_id).catch(() => ({ error: 'details unavailable' }))));
        const totals = monthTotals(month, list, entries);
        return { ...totals, settlements: totals.settlements.map((s) => ({ ...s, details: details[list.indexOf(s)] })) };
      }

      case 'get_settlements': {
        const range = month
          ? monthRange(month)
          : { from: new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
        const list = await listSettlements(ctx, range.from, range.to);
        return { settlements: list, count: list.length };
      }

      case 'get_settlement_details': {
        const id = Number(args.settlement_id);
        if (!Number.isInteger(id)) return { error: 'settlement_id is required (from get_settlements).' };
        return { settlement_id: id, details: await settlementDetails(ctx, id) };
      }

      case 'get_owner_charges': {
        const rows = await query(
          `SELECT ac.cost_name, ac.cost_desc, ac.cost_type, ac.supplier_name, ac.quantity, ac.measuring_unit,
                  COALESCE(ac.total_amount, ac.amount) AS amount, ac.billing_date, ac.is_settled,
                  t.task_title, t.task_type, t.status AS task_status, t.completed_at, u.unit_name
             FROM additional_cost ac
             JOIN task t ON t.id = ac.task_id
             JOIN unit u ON u.id = t.unit_id
            WHERE t.unit_id = ANY($1::int[]) AND lower(ac.bill_to) = 'owner'
              AND ($2::text IS NULL OR to_char(ac.billing_date, 'YYYY-MM') = $2)
              AND ($3::text IS NULL OR ac.cost_name ILIKE $3 OR ac.cost_desc ILIKE $3 OR t.task_title ILIKE $3)
            ORDER BY ac.billing_date DESC NULLS LAST LIMIT 25`,
          [ctx.unitIds, month, like],
        );
        return { charges: rows, count: rows.length };
      }

      case 'get_maintenance_tasks': {
        const rows = await query(
          `SELECT t.id, t.task_title, t.task_type, t.status, t.created_at, t.due_at, t.completed_at, u.unit_name,
                  (SELECT COALESCE(sum(COALESCE(ac.total_amount, ac.amount)), 0) FROM additional_cost ac
                    WHERE ac.task_id = t.id AND lower(ac.bill_to) = 'owner') AS billed_to_owner
             FROM task t JOIN unit u ON u.id = t.unit_id
            WHERE t.unit_id = ANY($1::int[]) AND t.created_at > now() - interval '180 days'
              AND ($2::text IS NULL OR t.task_title ILIKE $2 OR t.task_description ILIKE $2)
            ORDER BY t.created_at DESC LIMIT 15`,
          [ctx.unitIds, like],
        );
        return { tasks: rows, count: rows.length };
      }

      case 'raise_owner_query': {
        const ticket = queries.create({ ...args, source: 'assistant' });
        return { ticket_id: ticket.id, status: ticket.status, message: 'Query raised; the team will look into it.' };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[tool ${name}] failed:`, err.message);
    return { error: 'Could not load that data right now.' };
  }
}
