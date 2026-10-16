// All settings come from env (Render dashboard, or a local .env via `npm run dev`).
const trim = (v) => (v ?? '').trim().replace(/\/$/, '');

export const config = {
  port: Number(process.env.PORT || 3000),

  // The one owner this demo answers for. shortcut: no owner login; take the owner from a login before real use.
  ownerId: process.env.OWNER_ID || '',

  // ERP database (UAT), used read-only: owner details, units, charges, maintenance tasks.
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: process.env.DATABASE_SSL === 'true',

  // ERP API gateway (e.g. https://uat.example.com/api): settlements, same endpoint as Owner Financials.
  erpApiUrl: trim(process.env.ERP_API_URL),
  erpApiEmail: process.env.ERP_API_EMAIL || '',
  erpApiPassword: process.env.ERP_API_PASSWORD || '',

  // Gemini: chat model and Live (voice) model.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiChatModel: process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',
  geminiLiveModel: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  geminiVoice: process.env.GEMINI_VOICE || 'Zephyr',

  dataFile: process.env.DATA_FILE || new URL('../data/queries.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
};

const missing = ['ownerId', 'databaseUrl', 'erpApiUrl', 'erpApiEmail', 'erpApiPassword', 'geminiApiKey'].filter((k) => !config[k]);
if (missing.length) console.warn(`[config] missing settings: ${missing.join(', ')} — the assistant will not work until they are set.`);
