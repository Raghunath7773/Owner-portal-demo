import { VoiceClient } from './voice.js';

const $ = (id) => document.getElementById(id);
// Voice is served by this same server.
const VOICE_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`;
const state = { history: [], queries: [], filter: 'all', search: '', property: '' };

// ── helpers ──────────────────────────────────────────────────────────────
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Minimal, safe Markdown for assistant replies: **bold**, bullet lists, paragraphs. */
function renderMarkdown(text) {
  const blocks = [];
  let list = null;
  for (const raw of escapeHtml(text).split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const bullet = line.match(/^\s*[*-]\s+(.*)$/);
    if (bullet) { (list ??= []).push(`<li>${bullet[1]}</li>`); continue; }
    if (list) { blocks.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) blocks.push(`<p>${line}</p>`);
  }
  if (list) blocks.push(`<ul>${list.join('')}</ul>`);
  return blocks.join('');
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4000);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ── queries + scorecards ─────────────────────────────────────────────────
const statusClass = (s) => (s === 'Resolved' ? 'resolved' : s === 'Waiting for Owner' ? 'owner' : 'support');
const pad = (n) => String(n).padStart(2, '0');

async function loadQueries(highlightId) {
  const [queries, stats] = await Promise.all([api('/api/queries'), api('/api/stats')]);
  state.queries = queries;
  $('stat-total').textContent = pad(stats.total);
  $('stat-support').textContent = pad(stats.awaitingSupport);
  $('stat-owner').textContent = pad(stats.awaitingOwner);
  $('stat-resolved').textContent = pad(stats.resolved);

  const select = $('property-filter');
  const props = [...new Set(queries.map((q) => q.property))].sort();
  select.innerHTML = '<option value="">All properties</option>' + props.map((p) => `<option>${escapeHtml(p)}</option>`).join('');
  select.value = props.includes(state.property) ? state.property : '';
  renderQueries(highlightId);
}

function renderQueries(highlightId) {
  const term = state.search.toLowerCase();
  const rows = state.queries.filter((q) =>
    (state.filter === 'all' || (state.filter === 'resolved') === (q.status === 'Resolved')) &&
    (!state.property || q.property === state.property) &&
    (!term || `${q.subject} ${q.id} ${q.property}`.toLowerCase().includes(term)),
  );
  $('queries-count').textContent = `(${state.queries.length})`;
  $('queries-empty').hidden = rows.length > 0;
  $('queries-body').innerHTML = rows
    .map((q) => `<tr class="${q.id === highlightId ? 'fresh' : ''}">
      <td><span class="subject">${escapeHtml(q.subject)}</span><span class="meta">#${q.id} · ${q.messages} message${q.messages === 1 ? '' : 's'}</span></td>
      <td class="property">${escapeHtml(q.property)}</td>
      <td><span class="status ${statusClass(q.status)}">${q.status}</span></td>
    </tr>`)
    .join('');
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab); });
    state.filter = tab.dataset.filter;
    renderQueries();
  }),
);
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderQueries(); });
$('property-filter').addEventListener('change', (e) => { state.property = e.target.value; renderQueries(); });

// ── chat ─────────────────────────────────────────────────────────────────
function addMessage(role, html, extraClass = '') {
  const el = document.createElement('div');
  el.className = `msg ${role} ${extraClass}`;
  el.innerHTML = html;
  $('thread').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('ask-input').value.trim();
  if (!message) return;
  $('ask-input').value = '';
  $('ask-btn').disabled = true;
  addMessage('user', escapeHtml(message));
  const pending = addMessage('model', '<span class="typing"><i></i><i></i><i></i></span>');

  try {
    const { reply, tools } = await api('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, history: state.history }),
    });
    pending.innerHTML = renderMarkdown(reply || 'Sorry, I could not find an answer to that.');
    state.history.push({ role: 'user', text: message }, { role: 'model', text: reply });
    state.history = state.history.slice(-10);

    if (tools.includes('raise_owner_query')) {
      const ticket = reply.match(/OWN-\d{4}/)?.[0];
      await loadQueries(ticket);
      toast(ticket ? `Query ${ticket} added to My queries` : 'Your query was raised');
    }
  } catch (err) {
    pending.classList.add('error');
    pending.textContent = err.message;
  } finally {
    $('ask-btn').disabled = false;
    $('ask-input').focus();
  }
});

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => { $('ask-input').value = chip.dataset.q; $('ask-input').focus(); }),
);

// ── voice ────────────────────────────────────────────────────────────────
let voice = null;
let voicePoll = null;
const VOICE_TEXT = { connecting: 'Connecting…', listening: 'Listening — go ahead and speak', speaking: 'Assistant is speaking…' };

function onVoiceState(s, detail) {
  const box = $('voice-status');
  const active = s === 'connecting' || s === 'listening' || s === 'speaking';
  box.hidden = !active;
  box.classList.toggle('speaking', s === 'speaking');
  $('voice-text').textContent = VOICE_TEXT[s] ?? '';
  $('mic-btn').setAttribute('aria-pressed', String(active));
  // A query raised by voice should appear in My queries while the call is on.
  if (active && !voicePoll) voicePoll = setInterval(() => loadQueries().catch(() => {}), 5000);
  if (!active) { clearInterval(voicePoll); voicePoll = null; loadQueries().catch(() => {}); }
  if (s === 'error') toast(detail || 'Voice assistant is unavailable right now.');
}

$('mic-btn').addEventListener('click', async () => {
  if (voice?.active) return voice.stop();
  voice ??= new VoiceClient(VOICE_URL, onVoiceState);
  try {
    await voice.start();
  } catch {
    onVoiceState('error', 'Microphone access is needed for voice.');
  }
});
$('voice-stop').addEventListener('click', () => voice?.stop());

// ── new query dialog ─────────────────────────────────────────────────────
const dialog = $('query-dialog');
$('new-query-btn').addEventListener('click', () => dialog.showModal());
$('dialog-cancel').addEventListener('click', () => dialog.close());
$('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const q = await api('/api/queries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    dialog.close();
    e.target.reset();
    await loadQueries(q.id);
    toast(`Query ${q.id} raised. Our team will look into it.`);
  } catch (err) {
    toast(err.message);
  }
});

// ── boot ─────────────────────────────────────────────────────────────────
api('/api/config').then((cfg) => {
  $('owner-name').textContent = cfg.ownerName;
}).catch(() => {});
loadQueries().catch((err) => toast(err.message));
