const $ = (sel, root = document) => root.querySelector(sel);
const DECK_KEYS = 8; // Stream Deck Neo

let state = null;
let config = null;
let day = todayStr();
let lastSignature = '';

// ---------- api ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 2500);
}

const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------- formatting ----------

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const clientMatter = (m) => [m.client_no, m.matter_no].filter(Boolean).join('-');

// ---------- live state (SSE) ----------

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    renderRunning();
    renderDeck();
    // Refresh entries when something structural changes, or once a minute for hours.
    const sig = [state.running?.id, state.matters.map((m) => m.id + m.name + m.label + m.color).join(), Math.floor(state.now / 60000)].join('|');
    if (sig !== lastSignature) {
      lastSignature = sig;
      refreshDay();
      renderMatterOptions();
    }
  };
  es.onerror = () => {
    $('#running-label').textContent = 'Disconnected from deck-time server…';
  };
}

function renderRunning() {
  const r = state.running;
  $('#running').classList.toggle('idle', !r);
  $('#running-label').textContent = r ? r.matter.name : 'No timer running';
  $('#running-elapsed').textContent = r ? clock(state.now - r.start_ms) : '';
  $('#note-input').disabled = !r;
  $('#stop-btn').disabled = !r;
  const d = state.dictation;
  const btn = $('#dictate-btn');
  btn.disabled = !d || (!r && d.status === 'idle') || d.status === 'transcribing';
  btn.classList.toggle('recording', d?.status === 'recording');
  btn.textContent = d?.status === 'recording' ? `■ Stop (${clock(state.now - d.started_at)})` : d?.status === 'transcribing' ? 'Transcribing…' : '🎙 Dictate';
  if (d?.error && d.error !== renderRunning.lastError) toast(d.error, d.error !== 'Heard nothing');
  renderRunning.lastError = d?.error;
  if (d?.status === 'idle' && renderRunning.lastDictation === 'transcribing') refreshDay();
  renderRunning.lastDictation = d?.status;
  $('#total').textContent = `${state.total_hours.toFixed(1)} h today`;
  document.title = r ? `▶ ${clock(state.now - r.start_ms)} · ${r.matter.label}` : 'deck-time';
}

function renderDeck() {
  const keys = state.matters.slice(0, DECK_KEYS).map((m) => {
    const live = state.running?.matter_id === m.id;
    const ms = live ? state.now - state.running.start_ms : m.today_ms;
    return `<button class="key ${live ? 'live' : ''}" style="--key-color:${esc(m.color)}" data-toggle="${m.id}" title="${esc(m.name)}">
      <span>${esc(m.label || m.name)}</span>
      <span class="key-time">${live ? clock(ms) : ms ? clock(ms) : ''}</span>
      <span class="bar"></span>
    </button>`;
  });
  while (keys.length < DECK_KEYS) keys.push('<div class="key empty">empty</div>');
  $('#deck').innerHTML = keys.join('');
  if (!state.matters.length) {
    $('#deck').firstElementChild.outerHTML = '<button class="key empty" data-goto="matters">+ Add a matter</button>';
  }
}

// ---------- day / entries ----------

async function refreshDay(force = false) {
  // Don't clobber a field the user is typing in.
  if (!force && $('#entries').contains(document.activeElement)) return;
  const [data, segs] = await Promise.all([api(`/api/day?date=${day}`), api(`/api/segments?date=${day}`)]);
  renderEntries(data);
  renderSegments(segs);
}

function renderEntries({ entries }) {
  if (!entries.length) {
    $('#entries').innerHTML = `<div class="empty-state">No time recorded for ${day}. Tap a key to start a timer.</div>`;
    return;
  }
  $('#entries').innerHTML = entries
    .map(
      (e) => `
    <div class="entry status-${e.status}" style="--key-color:${esc(e.matter.color)}" data-matter="${e.matter_id}">
      <div class="entry-head">
        <span class="name">${esc(e.matter.name)}</span>
        <span class="cm">${esc(clientMatter(e.matter))}</span>
        ${e.running ? '<span class="live-badge">● running</span>' : ''}
        <span class="spacer"></span>
        <span class="raw" title="Raw timer time">${clock(e.raw_ms)}</span>
        <input class="hours" type="number" step="0.1" min="0" name="hours" value="${e.hours.toFixed(1)}" title="Billable hours (edit to override)">
        <select name="status">
          ${['draft', 'ready', 'exported'].map((s) => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <label>Notes (your shorthand)<textarea name="notes" rows="3" placeholder="e.g. tc w/ client re SPA reps; rev disclosure schedules">${esc(e.notes)}</textarea></label>
      <label>Narrative (what gets exported)<textarea name="narrative" rows="3">${esc(e.narrative)}</textarea></label>
      <div class="narr-actions">
        ${e.hours_override != null ? '<button data-action="reset-hours">Use timer hours</button>' : ''}
        <button data-action="draft">✨ Draft narrative</button>
      </div>
    </div>`,
    )
    .join('');
}

function renderSegments(segs) {
  const byId = Object.fromEntries(state.matters.map((m) => [m.id, m]));
  $('#segments tbody').innerHTML =
    segs
      .map((s) => {
        const end = s.end_ms ?? state.now;
        return `<tr data-seg="${s.id}" data-start="${s.start_ms}">
        <td>${esc(byId[s.matter_id]?.name ?? `#${s.matter_id}`)}</td>
        <td><input type="time" name="start" value="${hhmm(s.start_ms)}"></td>
        <td>${s.end_ms ? `<input type="time" name="end" value="${hhmm(s.end_ms)}">` : '<span class="live-badge">running</span>'}</td>
        <td>${Math.round((end - s.start_ms) / 60000)}</td>
        <td><button class="danger" data-action="del-seg">Delete</button></td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="5" class="empty-state">No segments</td></tr>';
}

function renderMatterOptions() {
  $('#add-segment select').innerHTML = state.matters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
}

// Time input on the viewed day -> epoch ms
function timeOnDay(hm) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

// ---------- matters tab ----------

async function renderMatters() {
  const matters = await api('/api/matters?all=1');
  $('#matters-table tbody').innerHTML = matters
    .map(
      (m) => `<tr data-id="${m.id}" style="${m.archived ? 'opacity:.5' : ''}">
      <td><span class="swatch" style="background:${esc(m.color)}"></span></td>
      <td>${esc(m.name)}</td><td>${esc(m.label)}</td><td>${esc(clientMatter(m))}</td>
      <td>${esc([m.task_code, m.activity_code].filter(Boolean).join(' / '))}</td>
      <td><button data-action="edit">Edit</button> <button data-action="archive">${m.archived ? 'Restore' : 'Archive'}</button></td>
    </tr>`,
    )
    .join('');
  renderMatters.cache = matters;
}

// ---------- settings tab ----------

const getPath = (obj, p) => p.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, p, v) {
  const keys = p.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = v;
}

async function renderSettings() {
  config = await api('/api/config');
  for (const el of $('#settings-form').elements) {
    if (!el.name) continue;
    const v = getPath(config, el.name);
    el.value = el.name === 'tim.defaults' ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join('\n') : String(v ?? '');
  }
  const pill = $('#tim-status');
  pill.className = 'pill ' + (config.timekeeper.id ? 'ok' : 'warn');
  pill.textContent = config.timekeeper.id ? `timekeeper ${config.timekeeper.id}` : 'set timekeeper ID or learn from an export';
  const ai = await api('/api/ai/status');
  const aiPill = $('#ai-status');
  aiPill.className = 'pill ' + (ai.reachable && ai.installed ? 'ok' : 'bad');
  aiPill.textContent = !ai.reachable ? 'Ollama not running' : ai.installed ? `${ai.model} ready` : `run: ollama pull ${ai.model}`;
  $('#ai-models').innerHTML = ai.models.map((m) => `<option value="${esc(m)}">`).join('');
}

function parseKeyValues(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

$('#tim-learn').addEventListener('change', guard(async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const r = await api('/api/tim/learn', { method: 'POST', body: { text: await file.text() } });
  ev.target.value = '';
  toast(`Learned from ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}` + (r.unknownVarying.length ? ` (unrecognized varying fields: ${r.unknownVarying.join(', ')})` : ''));
  renderSettings();
}));

// ---------- events ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'matters') renderMatters();
  if (name === 'settings') renderSettings();
}

document.addEventListener('click', guard(async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  if (t.dataset.tab) return showTab(t.dataset.tab);
  if (t.dataset.goto) return showTab(t.dataset.goto);
  if (t.dataset.toggle) return api('/api/timer/toggle', { method: 'POST', body: { matter_id: +t.dataset.toggle } });

  const entry = t.closest('.entry');
  if (entry && t.dataset.action === 'draft') {
    t.disabled = true;
    t.textContent = 'Drafting…';
    try {
      await saveEntryField(entry, entry.querySelector('[name=notes]'));
      await api(`/api/entries/${day}/${entry.dataset.matter}/narrate`, { method: 'POST', body: {} });
    } finally {
      await refreshDay(true);
    }
    return;
  }
  if (entry && t.dataset.action === 'reset-hours') {
    await api(`/api/entries/${day}/${entry.dataset.matter}`, { method: 'PATCH', body: { hours_override: null } });
    return refreshDay(true);
  }

  const seg = t.closest('[data-seg]');
  if (seg && t.dataset.action === 'del-seg') {
    if (!confirm('Delete this time segment?')) return;
    await api(`/api/segments/${seg.dataset.seg}`, { method: 'DELETE' });
    return refreshDay(true);
  }

  const row = t.closest('#matters-table tr[data-id]');
  if (row) {
    const m = renderMatters.cache.find((x) => x.id === +row.dataset.id);
    if (t.dataset.action === 'edit') {
      const form = $('#matter-form');
      for (const el of form.elements) if (el.name) el.value = m[el.name] ?? '';
      form.scrollIntoView({ behavior: 'smooth' });
    }
    if (t.dataset.action === 'archive') {
      await api(`/api/matters/${m.id}`, { method: 'PATCH', body: { archived: m.archived ? 0 : 1 } });
      renderMatters();
    }
  }
}));

async function saveEntryField(entry, el) {
  const matterId = entry.dataset.matter;
  const body = el.name === 'hours' ? { hours_override: el.value === '' ? null : +el.value } : { [el.name]: el.value };
  await api(`/api/entries/${day}/${matterId}`, { method: 'PATCH', body });
}

document.addEventListener('change', guard(async (ev) => {
  const el = ev.target;
  const entry = el.closest('.entry');
  if (entry) {
    await saveEntryField(entry, el);
    if (el.name !== 'notes' && el.name !== 'narrative') refreshDay(true);
    return;
  }
  const seg = el.closest('[data-seg]');
  if (seg) {
    const field = el.name === 'start' ? 'start_ms' : 'end_ms';
    await api(`/api/segments/${seg.dataset.seg}`, { method: 'PATCH', body: { [field]: timeOnDay(el.value) } });
    return refreshDay(true);
  }
}));

$('#note-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const input = $('#note-input');
  if (!input.value.trim()) return;
  await api('/api/timer/note', { method: 'POST', body: { text: input.value } });
  input.value = '';
  toast('Note added');
  refreshDay();
}));

$('#dictate-btn').addEventListener('click', guard(() => api('/api/dictation/toggle', { method: 'POST', body: {} })));
$('#stop-btn').addEventListener('click', guard(() => api('/api/timer/stop', { method: 'POST', body: {} })));

function setDay(d) {
  day = d;
  $('#day').value = d;
  refreshDay(true);
}
$('#day').addEventListener('change', (e) => e.target.value && setDay(e.target.value));
$('#prev-day').addEventListener('click', () => shiftDay(-1));
$('#next-day').addEventListener('click', () => shiftDay(1));
function shiftDay(n) {
  const [y, m, d] = day.split('-').map(Number);
  setDay(todayStr(new Date(y, m - 1, d + n)));
}

$('#draft-all').addEventListener('click', guard(async (ev) => {
  const btn = ev.currentTarget;
  const { entries } = await api(`/api/day?date=${day}`);
  const todo = entries.filter((e) => e.notes.trim() && !e.narrative.trim());
  if (!todo.length) return toast('Nothing to draft: entries need notes and no narrative yet');
  btn.disabled = true;
  try {
    for (const [i, e] of todo.entries()) {
      btn.textContent = `Drafting ${i + 1}/${todo.length}…`;
      await api(`/api/entries/${day}/${e.matter_id}/narrate`, { method: 'POST', body: {} });
    }
    toast(`Drafted ${todo.length} narrative${todo.length > 1 ? 's' : ''}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft missing narratives';
    refreshDay(true);
  }
}));

async function doExport(format) {
  const out = await api('/api/export', { method: 'POST', body: { date: day, format } });
  const blob = new Blob([out.body], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: out.filename });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${out.count} entr${out.count === 1 ? 'y' : 'ies'} (also saved to ${out.savedTo})`);
  refreshDay(true);
}
$('#export-tim').addEventListener('click', guard(() => doExport('tim')));
$('#export-csv').addEventListener('click', guard(() => doExport('csv')));

$('#add-segment').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await api('/api/segments', {
    method: 'POST',
    body: { matter_id: +f.matter_id.value, start_ms: timeOnDay(f.start.value), end_ms: timeOnDay(f.end.value) },
  });
  f.reset();
  renderMatterOptions();
  refreshDay(true);
}));

$('#matter-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = Object.fromEntries([...f.elements].filter((el) => el.name && el.name !== 'id').map((el) => [el.name, el.value.trim()]));
  if (f.id.value) await api(`/api/matters/${f.id.value}`, { method: 'PATCH', body });
  else await api('/api/matters', { method: 'POST', body });
  f.reset();
  f.id.value = '';
  toast('Matter saved');
  renderMatters();
}));

$('#settings-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const next = {};
  for (const el of ev.target.elements) {
    if (!el.name) continue;
    let v = el.value;
    if (el.type === 'number') v = +v;
    if (el.name === 'tim.defaults') v = parseKeyValues(v);
    setPath(next, el.name, v);
  }
  await api('/api/config', { method: 'PUT', body: next });
  toast('Settings saved');
  renderSettings();
}));

// Keyboard: 1–8 toggles deck keys (when not typing).
document.addEventListener('keydown', guard(async (ev) => {
  if (ev.target.closest('input, textarea, select') || ev.metaKey || ev.ctrlKey) return;
  const n = Number(ev.key);
  const m = state?.matters[n - 1];
  if (n >= 1 && n <= DECK_KEYS && m) await api('/api/timer/toggle', { method: 'POST', body: { matter_id: m.id } });
}));

$('#day').value = day;
connect();
