const $ = (sel, root = document) => root.querySelector(sel);
const DECK_KEYS = 8; // Stream Deck Neo

let state = null;
let config = null;
let day = todayStr();
let lastSignature = '';
const proposals = {}; // matterId -> pending AI split proposal

const entryPath = (el) => `/api/entries/${day}/${el.dataset.matter}${+el.dataset.part ? `/${el.dataset.part}` : ''}`;

// ---------- api ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
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
  $('#running-label').textContent = r ? `${r.matter.name}${r.tasks_today > 1 ? ` · task ${r.tasks_today}` : ''}` : 'No timer running';
  $('#running-elapsed').textContent = r ? clock(state.now - r.start_ms) : '';
  $('#note-input').disabled = !r;
  $('#stop-btn').disabled = !r;
  $('#next-task-btn').disabled = !r;
  const d = state.dictation;
  const btn = $('#dictate-btn');
  btn.disabled = !d || (!r && d.status === 'idle') || d.status === 'transcribing';
  btn.classList.toggle('recording', d?.status === 'recording');
  btn.textContent = d?.status === 'recording' ? `Stop recording ${clock(state.now - d.started_at)}` : d?.status === 'transcribing' ? 'Transcribing…' : 'Dictate';
  if (d?.error && d.error !== renderRunning.lastError) toast(d.error, d.error !== 'Heard nothing');
  renderRunning.lastError = d?.error;
  if (d?.status === 'idle' && renderRunning.lastDictation === 'transcribing') refreshDay();
  renderRunning.lastDictation = d?.status;
  $('#total').textContent = `${state.total_hours.toFixed(1)} h today`;
  document.title = r ? `${clock(state.now - r.start_ms)} · ${r.matter.label || r.matter.name}` : 'deck-time';
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
  while (keys.length < DECK_KEYS) keys.push('<div class="key empty"></div>');
  $('#deck').innerHTML = keys.join('');
  if (!state.matters.length) {
    $('#deck').firstElementChild.outerHTML = '<button class="key empty" data-goto="matters">Add a matter</button>';
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

function codeOptions(codes, selected, fallback) {
  const opts = Object.entries(codes).map(([c, label]) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c} · ${esc(label)}</option>`);
  const none = fallback ? `matter default (${fallback})` : 'choose…';
  return `<option value="">${esc(none)}</option>${opts.join('')}`;
}

/** Task/activity pickers, only for matters that use UTBMS codes. */
function codeRow(e) {
  const set = config?.codes.taskSets[e.matter.code_set];
  if (!set) return '';
  const missing = !e.task || !e.activity;
  return `<div class="codes ${missing ? 'missing' : ''}">
    <label>Task code<select name="task_code">${codeOptions(set.codes, e.task_code, e.matter.task_code)}</select></label>
    <label>Activity code<select name="activity_code">${codeOptions(config.codes.activities, e.activity_code, e.matter.activity_code)}</select></label>
    <button data-action="codes" title="Let the local AI pick codes from the narrative">Suggest codes</button>
  </div>`;
}

function rulesBadge(e) {
  if (!e.rules.no_block_billing && !e.rules.guidelines) return '';
  const tip = esc([e.rules.no_block_billing ? `No block billing (${e.rules.source} rule)` : '', e.rules.guidelines].filter(Boolean).join('\n'));
  return e.rules.no_block_billing
    ? `<span class="rule-badge" title="${tip}">No block billing</span>`
    : `<span class="rule-badge soft" title="${tip}">Guidelines</span>`;
}

function entryCard(e) {
  const main = e.part === 0;
  const alloc =
    main && e.parts > 1
      ? `<div class="alloc ${e.over_allocated ? 'bad' : ''}">Timer ${e.computed_hours.toFixed(1)}h: ${e.split_hours.toFixed(1)}h split off, ${e.hours.toFixed(1)}h here${e.over_allocated ? '. Over-allocated: reduce the split entries' : ''}</div>`
      : '';
  return `
    <div class="entry status-${e.status} ${main ? '' : 'part'}" style="--key-color:${esc(e.matter.color)}" data-matter="${e.matter_id}" data-part="${e.part}">
      <div class="entry-head">
        ${main ? `<span class="name">${esc(e.matter.name)}</span><span class="cm">${esc(clientMatter(e.matter))}</span>${rulesBadge(e)}` : `<span class="part-label">Split entry ${e.part}</span>`}
        ${e.running ? '<span class="live-badge">Running</span>' : ''}
        ${e.block_warning ? '<span class="warn-badge" title="This client prohibits block billing">looks block-billed</span>' : ''}
        <span class="spacer"></span>
        ${main ? `<span class="raw" title="Raw timer time">${clock(e.raw_ms)}</span>` : ''}
        <input class="hours" type="number" step="0.1" min="0" name="hours" value="${e.hours.toFixed(1)}" title="${main ? 'Billable hours (edit to override)' : 'Hours for this split entry'}">
        <select name="status">
          ${['draft', 'ready', 'exported'].map((s) => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        ${main ? '' : '<button class="icon danger" data-action="del-part" title="Remove this split entry (its hours go back to the main entry)">Remove</button>'}
      </div>
      ${alloc}
      <label>Notes<textarea name="notes" rows="3" placeholder="e.g. tc w/ client re SPA reps; rev disclosure schedules">${esc(e.notes)}</textarea></label>
      <label>Narrative (exported)<textarea name="narrative" rows="3">${esc(e.narrative)}</textarea></label>
      ${codeRow(e)}
      <div class="narr-actions">
        ${main && e.hours_override != null ? '<button data-action="reset-hours">Use timer hours</button>' : ''}
        ${main ? '<button data-action="add-part" title="Split off a separate entry by hand">Add split</button>' : ''}
        ${main && (e.rules.no_block_billing || e.parts > 1) ? '<button data-action="propose-split" title="Let the local AI split the day into one entry per task">Split into tasks</button>' : ''}
        <button data-action="draft">Draft narrative</button>
      </div>
    </div>`;
}

function proposalPanel(matterId, matter) {
  const p = proposals[matterId];
  if (!p) return '';
  const set = config?.codes.taskSets[matter.code_set];
  const sum = p.entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const off = Math.abs(sum - p.total_hours) > 0.001;
  return `<div class="split-panel" data-proposal="${matterId}">
    <div class="split-head"><strong>Proposed split</strong> <span class="${off ? 'bad' : ''}">${sum.toFixed(1)} of ${p.total_hours.toFixed(1)}h</span>
      <small>${p.mode === 'tasks' ? 'From your task breaks, so durations are exact.' : 'Estimated by the local AI from your notes.'} Review and edit before applying. The first row becomes the main entry.</small></div>
    ${p.entries
      .map(
        (e, i) => `<div class="split-row" data-i="${i}">
        <input type="number" step="0.1" min="0.1" name="hours" value="${Number(e.hours).toFixed(1)}">
        <div class="split-text">${e.range ? `<small>${hhmm(e.range[0])}–${hhmm(e.range[1])}${e.notes ? ` · ${esc(e.notes)}` : ' · no notes: write this one'}</small>` : ''}<textarea name="narrative" rows="2" placeholder="Narrative">${esc(e.narrative)}</textarea></div>
        ${set ? `<select name="task_code">${codeOptions(set.codes, e.task_code, '')}</select><select name="activity_code">${codeOptions(config.codes.activities, e.activity_code, '')}</select>` : ''}
        <button class="icon danger" data-action="drop-row" title="Remove row">Remove</button>
      </div>`,
      )
      .join('')}
    <div class="split-actions"><button data-action="cancel-split">Cancel</button><button class="primary" data-action="apply-split" ${off ? 'title="Hours don\'t add up; the main entry will absorb the difference"' : ''}>Apply split</button></div>
  </div>`;
}

function renderEntries({ entries }) {
  if (!entries.length) {
    $('#entries').innerHTML = `<div class="empty-state">No time recorded for ${day}. Tap a key to start a timer.</div>`;
    return;
  }
  const html = [];
  entries.forEach((e, i) => {
    html.push(entryCard(e));
    const lastOfMatter = entries[i + 1]?.matter_id !== e.matter_id;
    if (lastOfMatter) html.push(proposalPanel(e.matter_id, e.matter));
  });
  $('#entries').innerHTML = html.join('');
}

function renderSegments(segs) {
  const byId = Object.fromEntries(state.matters.map((m) => [m.id, m]));
  $('#segments tbody').innerHTML =
    segs
      .map((s) => {
        const end = s.end_ms ?? state.now;
        return `<tr data-seg="${s.id}" data-start="${s.start_ms}">
        <td>${esc(byId[s.matter_id]?.name ?? `#${s.matter_id}`)}</td>
        <td>${s.task + 1}</td>
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

let clientsCache = [];
const clientRule = (no) => (clientsCache.find((c) => c.client_no === no)?.no_block_billing ? 'No block (client)' : '');

async function renderClients() {
  clientsCache = await api('/api/clients');
  $('#clients').innerHTML = clientsCache.length
    ? clientsCache
        .map(
          (c) => `<form class="card client-card" data-client="${esc(c.client_no)}">
        <div class="client-head">
          <strong>${esc(c.client_no)}</strong>
          <input name="name" value="${esc(c.name)}" placeholder="Client name (optional)">
          <label class="check"><input type="checkbox" name="no_block_billing" ${c.no_block_billing ? 'checked' : ''}> No block billing</label>
        </div>
        <textarea name="guidelines" rows="2" placeholder="e.g. Separate legal analysis, internal emails about it, and any calls into distinct entries.">${esc(c.guidelines)}</textarea>
        <div class="client-foot"><small>${c.matters.map((m) => esc(m.name)).join(' · ') || 'no active matters'}</small><button type="submit">Save</button></div>
      </form>`,
        )
        .join('')
    : '<div class="empty-state">Add a matter with a client number to set client rules.</div>';
}

document.addEventListener('submit', guard(async (ev) => {
  const form = ev.target.closest('.client-card');
  if (!form) return;
  ev.preventDefault();
  await api(`/api/clients/${encodeURIComponent(form.dataset.client)}`, {
    method: 'PUT',
    body: { name: form.name.value.trim(), no_block_billing: form.no_block_billing.checked, guidelines: form.guidelines.value.trim() },
  });
  toast('Client rules saved');
  renderMatters();
}));

async function renderMatters() {
  await renderClients();
  const matters = await api('/api/matters?all=1');
  $('#matters-table tbody').innerHTML = matters
    .map(
      (m) => `<tr data-id="${m.id}" style="${m.archived ? 'opacity:.5' : ''}">
      <td><span class="swatch" style="background:${esc(m.color)}"></span></td>
      <td>${esc(m.name)}</td><td>${esc(m.label)}</td><td>${esc(clientMatter(m))}</td>
      <td>${m.code_set ? esc([config?.codes.taskSets[m.code_set]?.label ?? m.code_set, m.task_code, m.activity_code].filter(Boolean).join(' · ')) : '<span style="opacity:.5">none</span>'}</td>
      <td>${esc(m.block_billing === 'prohibited' ? 'No block (matter)' : m.block_billing === 'allowed' ? 'Block OK (matter)' : clientRule(m.client_no))}</td>
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
  pill.className = 'status ' + (config.timekeeper.id ? 'ok' : 'warn');
  pill.textContent = config.timekeeper.id ? `Timekeeper ${config.timekeeper.id}` : 'Set a timekeeper ID or learn it from an export';
  const ai = await api('/api/ai/status');
  const aiPill = $('#ai-status');
  aiPill.className = 'status ' + (ai.reachable && ai.installed ? 'ok' : 'bad');
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
      await api(`${entryPath(entry)}/narrate`, { method: 'POST', body: {} });
    } finally {
      await refreshDay(true);
    }
    return;
  }
  if (entry && t.dataset.action === 'codes') {
    t.disabled = true;
    t.textContent = 'Choosing…';
    try {
      await saveEntryField(entry, entry.querySelector('[name=narrative]'));
      await api(`${entryPath(entry)}/codes`, { method: 'POST', body: {} });
    } finally {
      await refreshDay(true);
    }
    return;
  }
  if (entry && t.dataset.action === 'add-part') {
    await api(`/api/entries/${day}/${entry.dataset.matter}/parts`, { method: 'POST', body: { hours: 0.1 } });
    return refreshDay(true);
  }
  if (entry && t.dataset.action === 'del-part') {
    await api(entryPath(entry), { method: 'DELETE' });
    return refreshDay(true);
  }
  if (entry && t.dataset.action === 'propose-split') {
    t.disabled = true;
    t.textContent = 'Splitting…';
    try {
      await saveEntryField(entry, entry.querySelector('[name=notes]'));
      proposals[entry.dataset.matter] = await api(`/api/entries/${day}/${entry.dataset.matter}/split/propose`, { method: 'POST', body: {} });
    } finally {
      await refreshDay(true);
    }
    return;
  }
  const panel = t.closest('[data-proposal]');
  if (panel && t.dataset.action) {
    const matterId = panel.dataset.proposal;
    readProposal(panel);
    if (t.dataset.action === 'drop-row') proposals[matterId].entries.splice(+t.closest('.split-row').dataset.i, 1);
    if (t.dataset.action === 'cancel-split' || !proposals[matterId].entries.length) delete proposals[matterId];
    if (t.dataset.action === 'apply-split') {
      await api(`/api/entries/${day}/${matterId}/split/apply`, { method: 'POST', body: { entries: proposals[matterId].entries } });
      delete proposals[matterId];
      toast('Split applied');
    }
    return refreshDay(true);
  }
  if (entry && t.dataset.action === 'reset-hours') {
    await api(entryPath(entry), { method: 'PATCH', body: { hours_override: null } });
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
  const body = el.name === 'hours' ? { hours_override: el.value === '' ? null : +el.value } : { [el.name]: el.value };
  await api(entryPath(entry), { method: 'PATCH', body });
}

/** Pull edits from the proposal panel back into memory. */
function readProposal(panel) {
  const p = proposals[panel.dataset.proposal];
  panel.querySelectorAll('.split-row').forEach((row) => {
    const e = p.entries[+row.dataset.i];
    for (const el of row.querySelectorAll('[name]')) e[el.name] = el.name === 'hours' ? +el.value : el.value;
  });
}

document.addEventListener('change', guard(async (ev) => {
  const el = ev.target;
  const panel = el.closest('[data-proposal]');
  if (panel) {
    readProposal(panel);
    return;
  }
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
$('#next-task-btn').addEventListener('click', guard(async () => {
  const input = $('#note-input');
  await api('/api/timer/next-task', { method: 'POST', body: { label: input.value } });
  input.value = '';
  toast('New task started');
  refreshDay();
}));
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
    btn.textContent = 'Draft all';
    refreshDay(true);
  }
}));

async function doExport(format) {
  let out;
  try {
    out = await api('/api/export', { method: 'POST', body: { date: day, format } });
  } catch (e) {
    if (e.status !== 409 || !e.data?.warnings) throw e;
    if (!confirm(`${e.data.warnings.join('\n')}\n\nExport anyway?`)) return;
    out = await api('/api/export', { method: 'POST', body: { date: day, format, force: true } });
  }
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
api('/api/config')
  .then((c) => (config = c))
  .catch(() => {})
  .finally(() => {
    fillCodeSetOptions();
    connect();
  });

function fillCodeSetOptions() {
  const sets = config?.codes.taskSets ?? {};
  $('#matter-form [name=code_set]').innerHTML =
    '<option value="">None</option>' + Object.entries(sets).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
}
