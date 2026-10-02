import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startCompanion } from '../src/host.js';

let app;
let home;
const quiet = () => {};

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-office-'));
  app = await startCompanion({ home, edition: 'office', port: 0, log: quiet });
});
after(() => app.close());

const api = (p, { method = 'GET', body } = {}) =>
  fetch(app.url + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
const json = async (p, opts) => (await api(p, opts)).json();

test('office edition: AI and dictation off, data in the given folder', async () => {
  const cfg = await json('/api/config');
  assert.deepEqual(cfg.features, { ai: false, dictation: false });
  assert.ok(fs.existsSync(path.join(home, 'config.json')));
  assert.ok(fs.existsSync(path.join(home, 'deck-time.db')));
  const state = await json('/api/state');
  assert.equal(state.dictation, null);
  assert.equal(state.workspace, 'real');
});

test('office edition serves the review page', async () => {
  const res = await api('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /deck-time/);
});

test('office edition drafts instantly without AI; exact task splits too', async () => {
  const m = await json('/api/matters', { method: 'POST', body: { name: 'Alpha', client_no: '1', matter_no: '1' } });
  await api('/api/timer/toggle', { method: 'POST', body: { matter_id: m.id } });
  await api('/api/timer/note', { method: 'POST', body: { text: 'analysis' } });
  await api('/api/timer/next-task', { method: 'POST', body: { label: 'email' } });
  await api('/api/timer/stop', { method: 'POST', body: {} });
  const { today } = await json('/api/state');

  const narrate = await api(`/api/entries/${today}/${m.id}/narrate`, { method: 'POST', body: {} });
  assert.equal(narrate.status, 200);
  assert.equal((await narrate.json()).narrative, 'Analysis; emailed.');

  const split = await json(`/api/entries/${today}/${m.id}/split/propose`, { method: 'POST', body: {} });
  assert.equal(split.mode, 'tasks');
  assert.deepEqual(split.entries.map((e) => [e.notes, e.narrative]), [['analysis', 'Analysis.'], ['email', 'Emailed.']]);
});

test('default keys without dictation: six matters, Next task, Stop', async () => {
  const { deck } = await json('/api/state');
  assert.deepEqual(deck.slice(6).map((s) => s.kind), ['next-task', 'stop']);
});

test('demo day switches to fictional matters and back without mixing data', async () => {
  const real = (await json('/api/state')).matters.map((m) => m.name);
  assert.deepEqual(real, ['Alpha']);

  await api('/api/timer/toggle', { method: 'POST', body: { matter_id: (await json('/api/matters'))[0].id } });
  let r = await json('/api/workspace', { method: 'POST', body: { workspace: 'demo' } });
  assert.equal(r.workspace, 'demo');
  let state = await json('/api/state');
  assert.equal(state.workspace, 'demo');
  assert.ok(state.matters.some((m) => m.name === 'Acme / Globex Merger'));
  assert.equal(state.matters.some((m) => m.name === 'Alpha'), false);
  assert.ok(fs.existsSync(path.join(home, 'demo.db')));

  r = await json('/api/workspace', { method: 'POST', body: { workspace: 'real' } });
  state = await json('/api/state');
  assert.deepEqual(state.matters.map((m) => m.name), ['Alpha']);
  assert.equal(state.running, null); // switching stopped the real timer rather than leaving it running
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).workspace, 'real');
});

test('reset demo day starts the demo over', async () => {
  await api('/api/workspace', { method: 'POST', body: { workspace: 'demo' } });
  const acme = (await json('/api/matters')).find((m) => m.label === 'Acme M&A');
  await api(`/api/matters/${acme.id}`, { method: 'PATCH', body: { label: 'Changed' } });
  await api('/api/workspace/reset-demo', { method: 'POST', body: {} });
  const labels = (await json('/api/matters')).map((m) => m.label);
  assert.ok(labels.includes('Acme M&A'));
  assert.equal(labels.includes('Changed'), false);
  await api('/api/workspace', { method: 'POST', body: { workspace: 'real' } });
});

test('demo day exports use a fictional timekeeper', async () => {
  await api('/api/config', { method: 'PUT', body: { timekeeper: { id: '77777' } } });
  await api('/api/workspace', { method: 'POST', body: { workspace: 'demo' } });
  const { today, matters } = await json('/api/state');
  const stark = matters.find((m) => m.label === 'Stark Board');
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime(); // not time-of-day dependent
  await api('/api/segments', { method: 'POST', body: { matter_id: stark.id, start_ms: midnight + 60_000, end_ms: midnight + 16 * 60_000 } });
  // Finish every entry on the sample day so the export validates.
  for (const e of (await json(`/api/day?date=${today}`)).entries) {
    const codes = e.matter.code_set === 'litigation' ? { task_code: 'L120', activity_code: 'A104' } : e.matter.code_set ? { task_code: 'C300', activity_code: 'A104' } : {};
    await api(`/api/entries/${today}/${e.matter_id}${e.part ? `/${e.part}` : ''}`, { method: 'PATCH', body: { narrative: 'Reviewed documents.', ...codes } });
  }
  const out = await json('/api/export', { method: 'POST', body: { date: today, markExported: false } });
  assert.equal(out.error, undefined, out.error);
  assert.match(out.body, /\|tk=10001\|/);
  assert.doesNotMatch(out.body, /77777/);
  await api('/api/workspace', { method: 'POST', body: { workspace: 'real' } });
});
