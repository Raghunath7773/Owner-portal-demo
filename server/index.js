import { createServer } from 'node:http';
import express from 'express';
import { config } from './config.js';
import { createQueryStore } from './queries.js';
import { chat } from './assistant/chat.js';
import { ownerContext } from './assistant/data.js';
import { attachVoice } from './assistant/voice.js';

const app = express();
const queries = createQueryStore(config.dataFile);

app.use(express.json({ limit: '100kb' }));
app.get('/healthz', (_req, res) => res.send('ok'));

app.use(express.static(new URL('../public', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')));

app.get('/api/config', async (_req, res) => {
  const ctx = await ownerContext().catch(() => null);
  res.json({ ownerName: ctx?.ownerName.split(' ')[0] ?? 'there' });
});

app.get('/api/queries', (_req, res) => res.json(queries.list()));
app.get('/api/stats', (_req, res) => res.json(queries.stats()));

// Created from the "New query" form (the assistant creates them through its raise_owner_query tool).
app.post('/api/queries', (req, res) => {
  try {
    res.status(201).json(queries.create({ ...req.body, source: 'portal' }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const message = String(req.body?.message ?? '').trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'message is required' });
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((h) => (h?.role === 'user' || h?.role === 'model') && typeof h.text === 'string')
    .slice(-10)
    .map((h) => ({ role: h.role, text: h.text.slice(0, 4000) }));
  try {
    res.json(await chat(message, history, queries));
  } catch (err) {
    console.error('[chat] failed:', err.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again.' });
  }
});

const server = createServer(app);
attachVoice(server, queries);
server.listen(config.port, () => console.log(`Owner portal demo on http://localhost:${config.port}`));
