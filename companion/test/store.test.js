import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import fs from 'node:fs';
import { intappDateTime, learnFromTim, parseTim, toCsv, toTim, validateForTim } from '../src/export.js';
import { buildPrompt, cleanNarrative, draftNarrative } from '../src/ai.js';
import { Store } from '../src/store.js';
import { dayBounds, formatDate, roundHours } from '../src/time.js';

const MIN = 60_000;

function setup() {
  let t = new Date(2026, 8, 29, 9, 0).getTime(); // 2026-09-29 09:00 local
  const clock = { now: () => t, advance: (ms) => (t += ms), set: (ms) => (t = ms) };
  const store = new Store(':memory:', () => DEFAULTS, clock.now);
  return { store, clock };
}

test('roundHours rounds up to tenths with a minimum', () => {
  const r = DEFAULTS.rounding;
  assert.equal(roundHours(0, r), 0);
  assert.equal(roundHours(1 * MIN, r), 0.1);
  assert.equal(roundHours(6 * MIN, r), 0.1);
  assert.equal(roundHours(6 * MIN + 1000, r), 0.2);
  assert.equal(roundHours(60 * MIN, r), 1);
  assert.equal(roundHours(7 * MIN, { ...r, mode: 'nearest' }), 0.1);
  assert.equal(roundHours(10 * MIN, { ...r, mode: 'nearest' }), 0.2);
});

test('formatDate handles padded and unpadded tokens', () => {
  assert.equal(formatDate('2026-09-05', 'MM/DD/YYYY'), '09/05/2026');
  assert.equal(formatDate('2026-09-05', 'M/D/YY'), '9/5/26');
  assert.equal(formatDate('2026-09-05', 'YYYYMMDD'), '20260905');
});

test('starting a timer stops the running one', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Alpha Merger', client_no: '1001', matter_no: '0001' });
  const b = store.createMatter({ name: 'Beta Financing' });

  store.toggle(a.id);
  assert.equal(store.running().matter_id, a.id);
  clock.advance(30 * MIN);
  store.toggle(b.id);
  assert.equal(store.running().matter_id, b.id);
  clock.advance(12 * MIN);
  store.toggle(b.id); // stop
  assert.equal(store.running(), null);

  const day = store.day('2026-09-29');
  const byName = Object.fromEntries(day.entries.map((e) => [e.matter.name, e.hours]));
  assert.deepEqual(byName, { 'Alpha Merger': 0.5, 'Beta Financing': 0.2 });
  assert.equal(day.total_hours, 0.7);
});

test('time accumulates across multiple segments before rounding', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Alpha' });
  for (let i = 0; i < 3; i++) {
    store.toggle(a.id);
    clock.advance(2 * MIN);
    store.toggle(a.id);
    clock.advance(10 * MIN);
  }
  // 6 minutes total = 0.1, not 3 x 0.1
  assert.equal(store.day('2026-09-29').entries[0].hours, 0.1);
});

test('a timer running past midnight splits across days', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Late Night' });
  clock.set(new Date(2026, 8, 29, 23, 30).getTime());
  store.toggle(a.id);
  clock.set(new Date(2026, 8, 30, 0, 45).getTime());
  store.toggle(a.id);
  assert.equal(store.day('2026-09-29').entries[0].hours, 0.5);
  assert.equal(store.day('2026-09-30').entries[0].hours, 0.8);
});

test('running timer counts toward today in state()', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Alpha' });
  store.toggle(a.id);
  clock.advance(20 * MIN);
  const s = store.state();
  assert.equal(s.running.matter.name, 'Alpha');
  assert.equal(s.matters[0].today_ms, 20 * MIN);
  assert.equal(s.total_hours, 0.4);
});

test('hours override and notes', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Alpha' });
  store.toggle(a.id);
  store.addNote('call w/ client');
  store.addNote('rev SPA');
  clock.advance(14 * MIN);
  store.stop();
  let e = store.day('2026-09-29').entries[0];
  assert.equal(e.notes, 'call w/ client; rev SPA');
  assert.equal(e.hours, 0.3);
  store.updateEntry('2026-09-29', a.id, { hours_override: 0.5 });
  e = store.day('2026-09-29').entries[0];
  assert.equal(e.hours, 0.5);
  assert.equal(e.computed_hours, 0.3);
});

test('archiving a matter stops its timer', () => {
  const { store } = setup();
  const a = store.createMatter({ name: 'Alpha' });
  store.toggle(a.id);
  store.updateMatter(a.id, { archived: 1 });
  assert.equal(store.running(), null);
  assert.throws(() => store.toggle(a.id), /archived/);
});

test('dayBounds covers a full local day', () => {
  const [s, e] = dayBounds('2026-09-29');
  assert.equal(e - s, 24 * 60 * MIN);
});

const sampleEntry = {
  date: '2026-09-29',
  hours: 1.2,
  narrative: 'Reviewed purchase agreement | revised\nschedules.',
  notes: 'rev SPA',
  matter: { client_no: '123456', matter_no: '00001', name: 'Alpha' },
};
const SAMPLE = fs.readFileSync(new URL('../../docs/samples/intapp-export.example.tim', import.meta.url), 'utf8');
const timConfig = { ...DEFAULTS, timekeeper: { id: '10001', name: '' } };
const fixed = { now: new Date(2026, 8, 29, 22, 12, 16).getTime(), uuid: () => '00000000-0000-4000-8000-000000000001' };

test('intappDateTime matches Intapp formatting', () => {
  assert.equal(intappDateTime(new Date(2026, 8, 29, 22, 12, 16).getTime()), '9/29/2026 10:12:16 PM');
  assert.equal(intappDateTime(new Date(2026, 0, 5, 0, 3, 9).getTime()), '1/5/2026 12:03:09 AM');
  assert.equal(intappDateTime(new Date(2026, 0, 5, 12, 0, 0).getTime()), '1/5/2026 12:00:00 PM');
});

test('toTim reproduces a real Intapp line (minus Intapp-assigned ids)', () => {
  const out = toTim([{ ...sampleEntry, narrative: 'Test entry.' }], timConfig, fixed);
  const expected = SAMPLE.split('\r\n')[0].replace('ar=100000001|', '').replace('shortref=20000001|', '') + '\r\n';
  assert.equal(out, expected);
});

test('toTim sanitizes narrative and converts hours to seconds', () => {
  const [rec] = parseTim(toTim([sampleEntry], timConfig, fixed));
  assert.equal(rec.na, 'Reviewed purchase agreement / revised schedules.');
  assert.equal(rec.am, '4320');
  assert.equal(rec.ss, '888888004320');
  assert.equal(rec.ma, '123456.00001');
  assert.equal(toTim([sampleEntry, sampleEntry], timConfig).split('\r\n').length, 3);
});

test('toTim gives each entry a fresh ref', () => {
  const recs = parseTim(toTim([sampleEntry, sampleEntry], timConfig));
  assert.notEqual(recs[0].ref, recs[1].ref);
  assert.match(recs[0].ref, /^[0-9a-f-]{36}$/);
});

test('validateForTim flags missing pieces', () => {
  const problems = validateForTim([{ ...sampleEntry, narrative: '', matter: { name: 'X', client_no: '1' } }], DEFAULTS);
  assert.deepEqual(problems, ['Set your timekeeper ID in Settings', 'X: missing narrative', 'X: missing matter number']);
});

test('learnFromTim extracts constants and timekeeper', () => {
  const l = learnFromTim(SAMPLE);
  assert.equal(l.entries, 2);
  assert.equal(l.timekeeperId, '10001');
  assert.equal(l.ssPrefix, '888888');
  assert.deepEqual(l.defaults, DEFAULTS.tim.defaults);
  assert.deepEqual(l.unknownVarying, []);
  assert.throws(() => learnFromTim('hello'), /doesn't look like/);
});

test('toCsv quotes as needed', () => {
  const out = toCsv([{ ...sampleEntry, narrative: 'Drafted memo, "final"' }]);
  assert.match(out, /"Drafted memo, ""final"""/);
});

test('buildPrompt includes examples and matter', () => {
  const msgs = buildPrompt({ matter: { name: 'Alpha' }, notes: 'rev SPA', hours: 1, styleGuide: 'Be terse.', examples: DEFAULTS.ai.examples });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Be terse/);
  assert.equal(msgs.at(-1).role, 'user');
  assert.match(msgs.at(-1).content, /Matter: Alpha/);
});

test('cleanNarrative strips wrappers', () => {
  assert.equal(cleanNarrative('<think>hmm</think>\n"Narrative: Reviewed agreement."'), 'Reviewed agreement.');
});

test('draftNarrative calls Ollama and cleans output', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ message: { content: ' "Reviewed stock purchase agreement." ' } }) };
  };
  const out = await draftNarrative({ config: DEFAULTS, matter: { name: 'Alpha' }, notes: 'rev SPA', hours: 1, fetchImpl });
  assert.equal(out, 'Reviewed stock purchase agreement.');
  assert.equal(sent.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(sent.body.model, DEFAULTS.ai.model);
});

test('draftNarrative explains when Ollama is down', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(draftNarrative({ config: DEFAULTS, matter: { name: 'A' }, notes: 'x', fetchImpl }), /Is it running/);
});
