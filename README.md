# Owner Portal Demo (VirtueNXT)

Owner support page with an AI assistant (chat + voice) and "My queries". Fully separate from the ERP
codebase: one Node service serves the UI, the API, the chat agent and the voice WebSocket, so it
deploys to Render as a single web service. It reads ERP data from the UAT database (read-only) and
the ERP API.

```
owner-portal-demo/
├── server/
│   ├── index.js            Express app: static UI, /api/*; attaches /voice
│   ├── config.js           env settings
│   ├── queries.js          queries store (JSON file, seeded) + OWN-xxxx ticket ids  (+ test)
│   └── assistant/
│       ├── prompt.js       owner persona + company policy text
│       ├── data.js         read-only ERP DB pool, ERP API login, owner context
│       ├── tools.js        tool definitions + execution (settlements, charges, tasks, raise query)  (+ test)
│       ├── chat.js         text chat: Gemini + tools
│       └── voice.js        /voice WebSocket ⇄ Gemini Live, same tools
├── public/                 index.html, styles.css, js/app.js, js/voice.js
├── data/                   queries.json is written here at runtime
├── render.yaml
└── .env.example
```

## What answers what

| Owner asks | Tool | Source |
|---|---|---|
| Income, month comparison | `get_income_summary` | ERP API `/virtual-inspect/owner-settlement` (same as Owner Financials) |
| "Break down September" | `get_month_breakdown` (one call: settlements + details) | ERP API |
| Settlement amount / details | `get_settlements`, `get_settlement_details` | ERP API |
| Charges | `get_owner_charges` | ERP DB `additional_cost` billed to owner |
| Repairs / maintenance | `get_maintenance_tasks` | ERP DB `task` |
| Problem / dispute | `raise_owner_query` → `OWN-xxxx` in My queries | this app |
| Payouts, documents, bank details | prompt policy text (`server/assistant/prompt.js`) | — |

## Run locally

```bash
cp .env.example .env   # fill in OWNER_ID, DATABASE_URL, ERP_API_*, GEMINI_API_KEY
npm install
npm run dev            # http://localhost:4100
npm test
```

## Deploy on Render

1. Push this folder to its own Git repo; create a **Blueprint** from `render.yaml` (or a Web Service: `npm ci` / `npm start`).
2. Fill the env vars marked `sync: false` in the Render dashboard.
3. The UAT Postgres must accept connections from Render (firewall/allow-list), and the ERP API URL must be public.

## Demo limits

- Queries live in `data/queries.json`; Render's free tier wipes it on redeploy (falls back to the seed data).
- No sign-in: anyone with the URL sees this owner's data and can use the assistant. Everything answers for `OWNER_ID`.
  The voice WebSocket only accepts connections from pages served by this app (Origin check).
- Fill in the `[placeholders]` in `server/assistant/prompt.js` (payout timing, contacts) before the demo.
