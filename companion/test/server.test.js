import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULTS, deepMerge } from '../src/config.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

let server, base, store;
const raised = []; // pages the Review key tried to bring forward (never touches real windows in tests)
let config = deepMerge(DEFAULTS, { timekeeper: { id: '4321' } });

before(async () => {
  store = new Store(':memory:', () => config);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: { content: 'Reviewed agreement.' } }) });
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-time-'));
  server = createServer({ store, getConfig: () => config, setConfig: (c) => (config = c), fetchImpl, exportDir, raiseWindow: async (page) => (raised.push(page), false) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

const api = (path, { method = 'GET', body, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

test('matter + timer + narrate + export flow', async () => {
  const m = await (await api('/api/matters', { method: 'POST', body: { name: 'Alpha', client_no: '123456', matter_no: '00002' } })).json();
  assert.equal(m.label, 'Alpha');

  let r = await api('/api/timer/toggle', { method: 'POST', body: { matter_id: m.id } });
  assert.equal((await r.json()).matter_id, m.id);
  await api('/api/timer/note', { method: 'POST', body: { text: 'rev agmt' } });
  await api('/api/timer/stop', { method: 'POST', body: {} });

  const date = (await (await api('/api/state')).json()).today;

  // Export refuses entries without a narrative.
  r = await api('/api/export', { method: 'POST', body: { date } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /missing narrative/);

  r = await api(`/api/entries/${date}/${m.id}/narrate`, { method: 'POST', body: {} });
  assert.equal((await r.json()).narrative, 'Reviewed agreement.');

  r = await api('/api/export', { method: 'POST', body: { date, markExported: false } });
  const out = await r.json();
  assert.equal(out.count, 1);
  assert.match(out.body, /^am=360\|.*\|cl=123456\|.*\|ma=123456\.00002\|.*\|na=Reviewed agreement\.\|.*\|tk=4321\|/);
});

test('cross-origin requests are blocked', async () => {
  const r = await api('/api/timer/stop', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('non-JSON posts are rejected', async () => {
  const r = await fetch(base + '/api/timer/stop', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

test('static files are served and traversal blocked', async () => {
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

test('deck mirrors what the Stream Deck reports; fixed keys cannot be rearranged', async () => {
  const before = await (await api('/api/deck')).json();
  assert.equal(before.some((s) => s.fixed), false); // nothing reported yet: pure layout

  // Top row deck-time Keys; bottom row set directly to functions in the Stream Deck app.
  const slots = [0, 1, 2, 3].map((slot) => ({ slot, kind: 'key' })).concat(
    [['dictate', 4], ['next-task', 5], ['stop', 6], ['review', 7]].map(([kind, slot]) => ({ slot, kind })),
  );
  let r = await api('/api/deck/physical', { method: 'POST', body: { columns: 4, rows: 2, slots } });
  assert.equal((await r.json()).keys, 8);
  const deck = await (await api('/api/deck')).json();
  assert.deepEqual(deck.slice(4).map((s) => [s.kind, s.fixed]), [['dictate', true], ['next-task', true], ['stop', true], ['review', true]]);
  assert.equal(deck[0].fixed, false);

  r = await api('/api/deck/5', { method: 'PUT', body: { kind: 'stop' } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Key 6 is set to Next task in the Stream Deck app/);
  r = await api('/api/deck/swap', { method: 'POST', body: { from: 0, to: 7 } });
  assert.equal(r.status, 409);

  // A position with no deck-time action at all shows as 'none'.
  await api('/api/deck/physical', { method: 'POST', body: { columns: 4, rows: 2, slots: slots.filter((s) => s.slot !== 7) } });
  const state = await (await api('/api/state')).json();
  assert.equal(state.deck[7].kind, 'none');
  assert.equal(state.deck[7].fixed, true);
});

test('codes are instant, need no AI, and exports teach the code memory', async () => {
  const m = await (await api('/api/matters', { method: 'POST', body: { name: 'Coded', client_no: '555555', matter_no: '00001', code_set: 'counseling' } })).json();
  const { today } = await (await api('/api/state')).json();
  // Fixed times early in today, so the test doesn't depend on the time of day it runs.
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  await api('/api/segments', { method: 'POST', body: { matter_id: m.id, start_ms: midnight + 60_000, end_ms: midnight + 11 * 60_000 } });

  // Saving a narrative fills codes immediately (keyword rules; no model call).
  const saved = await (await api(`/api/entries/${today}/${m.id}`, { method: 'PATCH', body: { narrative: 'Telephone conference with client regarding licensing.' } })).json();
  assert.deepEqual([saved.task_code, saved.activity_code], ['C300', 'A106']);

  const r = await (await api(`/api/entries/${today}/${m.id}/codes`, { method: 'POST', body: {} })).json();
  assert.equal(r.code_source.activity, 'rules');

  const before = (await (await api('/api/codes/memory')).json()).examples;
  await api('/api/export', { method: 'POST', body: { date: today, markExported: true, force: true } });
  const after = await (await api('/api/codes/memory')).json();
  assert.ok(after.examples > before);
  assert.ok(after.bySource.export >= 1);
});

test('importing past Intapp time teaches the code memory', async () => {
  const sample = fs.readFileSync(new URL('../../docs/samples/intapp-export-coded.example.tim', import.meta.url), 'utf8');
  const r = await (await api('/api/codes/import', { method: 'POST', body: { files: [sample] } })).json();
  assert.equal(r.found, 1);
  const bad = await api('/api/codes/import', { method: 'POST', body: { files: ['nothing here'] } });
  assert.equal(bad.status, 400);
});

test('the learning loop: instant draft, your correction at export, better next draft', async () => {
  const m = await (await api('/api/matters', { method: 'POST', body: { name: 'Loop', client_no: '777777', matter_no: '00001' } })).json();
  const { today } = await (await api('/api/state')).json();
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  await api('/api/segments', { method: 'POST', body: { matter_id: m.id, start_ms: midnight + 60_000, end_ms: midnight + 13 * 60_000 } });
  await api(`/api/entries/${today}/${m.id}`, { method: 'PATCH', body: { notes: 'rev deck for BOD' } });

  let e = await (await api(`/api/entries/${today}/${m.id}/narrate`, { method: 'POST', body: {} })).json();
  assert.equal(e.narrative, 'Reviewed deck for board of directors.');

  // You fix it, then export: the change is logged as a correction.
  await api(`/api/entries/${today}/${m.id}`, { method: 'PATCH', body: { narrative: 'Reviewed board presentation for board of directors.' } });
  await api('/api/export', { method: 'POST', body: { date: today, markExported: false, force: true } });
  const pb = await (await api('/api/phrasebook')).json();
  assert.ok(pb.corrections >= 1);
  assert.ok(pb.learned.some((r) => r.to === 'board presentation'));

  // Next draft on this matter already uses your phrasing.
  await api(`/api/entries/${today}/${m.id}`, { method: 'PATCH', body: { notes: 'rev deck' } });
  e = await (await api(`/api/entries/${today}/${m.id}/narrate`, { method: 'POST', body: {} })).json();
  assert.equal(e.narrative, 'Reviewed board presentation.');
});

test('Review key shows the open page instead of opening the default browser', async () => {
  // Nothing open: tell the plugin to open the address itself.
  let r = await (await api('/api/app/show', { method: 'POST', body: { view: 'review' } })).json();
  assert.equal(r.shown, false);
  assert.equal(raised.at(-1), null);

  // A page open as an installed app in Safari: it gets a 'show' event and is raised.
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?display=standalone`, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' },
  });
  const reader = res.body.getReader();
  await reader.read(); // initial state
  r = await (await api('/api/app/show', { method: 'POST', body: { view: 'review' } })).json();
  assert.equal(r.shown, true);
  try {
    assert.equal(raised.at(-1).display, 'standalone');
    assert.equal(raised.at(-1).browser, 'safari');
    let text = '';
    while (!text.includes('event: show')) text += new TextDecoder().decode((await reader.read()).value);
  } finally {
    ctrl.abort();
  }
});

test('state carries the daily target', async () => {
  const s = await (await api('/api/state')).json();
  assert.equal(s.daily_target, 8);
});

test('demo day shows a fictional timekeeper and never overwrites the real one', async () => {
  let cfg = deepMerge(DEFAULTS, { timekeeper: { id: '55555', name: 'Real Person' } });
  let ws = 'demo';
  const s = createServer({ store: new Store(':memory:', () => cfg), getConfig: () => cfg, setConfig: (c) => (cfg = c), workspace: { get: () => ws }, exportDir: os.tmpdir(), raiseWindow: async () => false });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    let shown = await (await fetch(`${b}/api/config`)).json();
    assert.equal(shown.timekeeper.id, '10001');
    // Saving Settings in demo (the form sends the shown ID back) keeps the real one.
    shown = await (await fetch(`${b}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timekeeper: { id: '10001' }, dailyTarget: 7 }) })).json();
    assert.equal(shown.timekeeper.id, '10001');
    assert.equal(cfg.timekeeper.id, '55555');
    assert.equal(cfg.dailyTarget, 7);
    ws = 'real';
    assert.equal((await (await fetch(`${b}/api/config`)).json()).timekeeper.id, '55555');
  } finally {
    s.close();
  }
});
