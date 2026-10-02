import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { intappDateTime, learnFromTim, parseTim, toCsv, toTim, validateForTim } from '../src/export.js';
import { buildPrompt, cleanNarrative, draftNarrative, suggestCodes } from '../src/ai.js';
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

// ---------- UTBMS codes ----------

const CODED_SAMPLE = fs.readFileSync(new URL('../../docs/samples/intapp-export-coded.example.tim', import.meta.url), 'utf8');

test('toTim writes u5/u6 for coded matters, matching a real coded line', () => {
  const entry = {
    date: '2026-09-29',
    hours: 1.2,
    narrative: 'Test entry.',
    task: 'C300',
    activity: 'A104',
    matter: { client_no: '222222', matter_no: '00101', name: 'Coded', code_set: 'counseling' },
  };
  const out = toTim([entry], timConfig, { ...fixed, uuid: () => '00000000-0000-4000-8000-000000000003' });
  const expected = CODED_SAMPLE.split('\r\n')[0]
    .replace('ar=100000003|', '')
    .replace('shortref=20000003|', '')
    .replace('md=9/29/2026 11:12:46 PM', 'md=9/29/2026 10:12:16 PM') + '\r\n';
  assert.equal(out, expected);
});

test('uncoded matters never get u5/u6', () => {
  const [rec] = parseTim(toTim([sampleEntry], timConfig, fixed));
  assert.equal('u5' in rec, false);
  assert.equal('u6' in rec, false);
});

test('validateForTim requires codes on coded matters', () => {
  const e = { ...sampleEntry, narrative: 'x', task: 'C300', activity: '', matter: { ...sampleEntry.matter, code_set: 'counseling' } };
  assert.deepEqual(validateForTim([e], timConfig), ['Alpha: needs task/activity codes']);
});

test('learnFromTim treats u5/u6 as per-entry, not constants', () => {
  const l = learnFromTim(SAMPLE + CODED_SAMPLE);
  assert.equal('u5' in l.defaults, false);
  assert.deepEqual(l.unknownVarying, []);
});

test('entries inherit matter default codes; entry codes override', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Coded', code_set: 'counseling', task_code: 'C300', activity_code: 'A104' });
  const plain = store.createMatter({ name: 'Plain', task_code: 'C100' });
  for (const id of [m.id, plain.id]) {
    store.toggle(id);
    clock.advance(6 * MIN);
  }
  store.stop();
  let day = store.day('2026-09-29');
  const coded = day.entries.find((e) => e.matter_id === m.id);
  assert.deepEqual([coded.task, coded.activity], ['C300', 'A104']);
  assert.deepEqual([day.entries.find((e) => e.matter_id === plain.id).task], ['']); // no code_set → no codes
  store.updateEntry('2026-09-29', m.id, { activity_code: 'A106' });
  day = store.day('2026-09-29');
  assert.equal(day.entries.find((e) => e.matter_id === m.id).activity, 'A106');
});

test('old databases gain the new columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mig-'));
  const file = path.join(dir, 'old.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE matters (id INTEGER PRIMARY KEY, client_no TEXT NOT NULL DEFAULT '', matter_no TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#3b82f6', task_code TEXT NOT NULL DEFAULT '', activity_code TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE entries (date TEXT NOT NULL, matter_id INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', narrative TEXT NOT NULL DEFAULT '',
    hours_override REAL, status TEXT NOT NULL DEFAULT 'draft', exported_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (date, matter_id));
    INSERT INTO matters (name, created_at) VALUES ('Legacy', 0);`);
  db.close();
  const store = new Store(file, () => DEFAULTS);
  const m = store.listMatters()[0];
  assert.equal(m.code_set, '');
  store.updateEntry('2026-09-29', m.id, { task_code: 'C100' });
  assert.equal(store.getEntry('2026-09-29', m.id).task_code, 'C100');
  store.close();
});

test('suggestCodes constrains the model to allowed codes', async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: '{"task_code":"C300","activity_code":"A104"}' } }) };
  };
  const codes = { tasks: DEFAULTS.codes.taskSets.counseling.codes, activities: DEFAULTS.codes.activities };
  const out = await suggestCodes({ config: DEFAULTS, narrative: 'Reviewed and analyzed merger agreement.', codes, fetchImpl });
  assert.deepEqual(out, { task_code: 'C300', activity_code: 'A104' });
  assert.deepEqual(body.format.properties.task_code.enum, ['C100', 'C200', 'C300', 'C400']);
  assert.equal(body.format.properties.activity_code.enum.length, 11);
});

test('suggestCodes rejects codes outside the list', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: { content: '{"task_code":"L120","activity_code":"A104"}' } }) });
  const codes = { tasks: DEFAULTS.codes.taskSets.counseling.codes, activities: DEFAULTS.codes.activities };
  await assert.rejects(suggestCodes({ config: DEFAULTS, narrative: 'x', codes, fetchImpl }), /unknown codes/);
});

test('Ollama unloads the model soon after use; code suggestions are deterministic', async () => {
  const bodies = [];
  const fetchImpl = async (_u, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ message: { content: '{"task_code":"C300","activity_code":"A104"}' } }) };
  };
  const codes = { tasks: DEFAULTS.codes.taskSets.counseling.codes, activities: DEFAULTS.codes.activities };
  await suggestCodes({ config: DEFAULTS, narrative: 'Reviewed agreement.', codes, fetchImpl });
  assert.equal(bodies[0].keep_alive, '2m');
  assert.equal(bodies[0].options.temperature, 0);
});

test('jurisdiction: entry overrides matter, matter overrides the export default', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'NY deal', client_no: '1', matter_no: '1', jurisdiction: '012' });
  const b = store.createMatter({ name: 'Default', client_no: '2', matter_no: '2' });
  for (const id of [a.id, b.id]) {
    store.toggle(id);
    clock.advance(6 * MIN);
  }
  store.stop();
  store.updateEntry('2026-09-29', a.id, { narrative: 'Reviewed.', jurisdiction: '031' });
  store.updateEntry('2026-09-29', b.id, { narrative: 'Reviewed.' });
  const cfg = { ...DEFAULTS, timekeeper: { id: '10001', name: '' } };
  const recs = parseTim(toTim(store.day('2026-09-29').entries, cfg));
  const byClient = Object.fromEntries(recs.map((r) => [r.cl, r.u1]));
  assert.deepEqual(byClient, { 1: '031', 2: DEFAULTS.tim.defaults.u1 });
  store.updateEntry('2026-09-29', a.id, { jurisdiction: '' });
  assert.equal(parseTim(toTim(store.day('2026-09-29').entries, cfg)).find((r) => r.cl === '1').u1, '012');
});
