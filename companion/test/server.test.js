import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULTS, deepMerge } from '../src/config.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

let server, base, store;
let config = deepMerge(DEFAULTS, { timekeeper: { id: '4321' } });

before(async () => {
  store = new Store(':memory:', () => config);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: { content: 'Reviewed agreement.' } }) });
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-time-'));
  server = createServer({ store, getConfig: () => config, setConfig: (c) => (config = c), fetchImpl, exportDir });
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
