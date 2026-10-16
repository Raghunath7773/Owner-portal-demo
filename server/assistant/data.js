import pg from 'pg';
import { config } from '../config.js';
import { buildOwnerPrompt } from './prompt.js';

// ── ERP database (read-only) ─────────────────────────────────────────────
// Server-side guard: every transaction on these connections is read-only.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 3,
  options: '-c default_transaction_read_only=on',
});
export const query = async (sql, params) => (await pool.query(sql, params)).rows;

// ── ERP API (settlements come from the same endpoint as the Owner Financials ledger) ──
let token = null;

async function login() {
  const res = await fetch(`${config.erpApiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.erpApiEmail, password: config.erpApiPassword }),
  });
  const body = await res.json().catch(() => ({}));
  const t = body?.data?.accessToken ?? body?.accessToken;
  if (!res.ok || !t) throw new Error(`ERP API login failed (${res.status})`);
  return t;
}

/** GET against the ERP API as the configured account; logs in again once on 401. */
export async function erpGet(path, retried = false) {
  token ??= await login();
  const res = await fetch(`${config.erpApiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) {
    token = null;
    return erpGet(path, true);
  }
  if (!res.ok) throw new Error(`ERP API ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

// ── Owner context (name, organization, units, rendered prompt) ───────────
let cached = null;

/** Loaded from the database once and reused for 10 minutes (the prompt carries today's date). */
export function ownerContext() {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.promise;
  const promise = loadOwnerContext().catch((err) => {
    cached = null; // retry next time instead of caching the failure
    throw err;
  });
  cached = { at: Date.now(), promise };
  return promise;
}

async function loadOwnerContext() {
  const [owner] = await query(
    `SELECT u."firstName", u."lastName", u.email, u.organization_id, o.organization_name, o.organization_email
       FROM users u LEFT JOIN organization o ON o.id = u.organization_id
      WHERE u.id = $1`,
    [config.ownerId],
  );
  if (!owner) throw new Error(`Owner ${config.ownerId} not found`);

  const units = await query(
    `SELECT DISTINCT u.id AS unit_id, u.unit_name, p.property_name, p.city, p.country
       FROM unit_ownership uo
       JOIN unit u ON u.id = uo.unit_id
       LEFT JOIN property p ON p.id = u.property_id
      WHERE uo.owner_id = $1 AND uo.start_date <= CURRENT_DATE
        AND (uo.end_date IS NULL OR uo.end_date >= CURRENT_DATE)
      ORDER BY p.property_name, u.unit_name`,
    [config.ownerId],
  );

  const ownerName = `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.replace(/\s+/g, ' ').trim() || 'Owner';
  return {
    ownerId: config.ownerId,
    orgId: Number(owner.organization_id),
    ownerName,
    unitIds: units.map((u) => Number(u.unit_id)),
    systemPrompt: buildOwnerPrompt({
      ownerName,
      ownerEmail: owner.email ?? null,
      organizationName: owner.organization_name ?? null,
      organizationEmail: owner.organization_email ?? null,
      units,
      today: new Date().toISOString().slice(0, 10),
    }),
  };
}
