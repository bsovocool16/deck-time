import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { normalizeSplit, proposeSplit } from '../src/ai.js';
import { DEFAULTS, deepMerge } from '../src/config.js';
import { exportable, parseTim, toTim } from '../src/export.js';
import { createServer } from '../src/server.js';
import { looksBlockBilled, Store } from '../src/store.js';

const MIN = 60_000;
const DATE = '2026-09-29';

function setup() {
  let t = new Date(2026, 8, 29, 9, 0).getTime();
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const store = new Store(':memory:', () => DEFAULTS, clock.now);
  return { store, clock };
}

function timeOn(store, clock, matterId, minutes) {
  store.toggle(matterId);
  clock.advance(minutes * MIN);
  store.stop();
}

test('client rules apply to all its matters; matter setting overrides', () => {
  const { store } = setup();
  const a = store.createMatter({ name: 'A', client_no: '222222', matter_no: '00101' });
  const b = store.createMatter({ name: 'B', client_no: '222222', matter_no: '00102', block_billing: 'allowed', guidelines: 'Litigation budget codes.' });
  const c = store.createMatter({ name: 'C', client_no: '555555' });
  store.updateClient('222222', { no_block_billing: true, guidelines: 'Separate analysis, internal emails, and calls.' });

  assert.deepEqual(store.rulesFor(store.getMatter(a.id)), {
    no_block_billing: true,
    source: 'client',
    guidelines: 'Separate analysis, internal emails, and calls.',
  });
  const rb = store.rulesFor(store.getMatter(b.id));
  assert.equal(rb.no_block_billing, false);
  assert.equal(rb.source, 'matter');
  assert.equal(rb.guidelines, 'Separate analysis, internal emails, and calls.\nLitigation budget codes.');
  assert.equal(store.rulesFor(store.getMatter(c.id)).no_block_billing, false);

  const clients = store.listClients();
  assert.deepEqual(clients.map((x) => x.client_no), ['222222', '555555']);
  assert.equal(clients[0].matters.length, 2);
});

test('split-off entries take hours from the main entry; totals reconcile', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha', client_no: '1', matter_no: '1' });
  timeOn(store, clock, m.id, 90); // 1.5h
  store.addPart(DATE, m.id, { hours: 0.3, notes: 'email to team' });
  store.addPart(DATE, m.id, { hours: 0.2, notes: 'call' });
  let day = store.day(DATE);
  assert.deepEqual(day.entries.map((e) => [e.part, e.hours]), [[0, 1], [1, 0.3], [2, 0.2]]);
  assert.equal(day.total_hours, 1.5);

  store.deletePart(DATE, m.id, 1);
  day = store.day(DATE);
  assert.deepEqual(day.entries.map((e) => [e.part, e.hours]), [[0, 1.3], [2, 0.2]]);
  assert.equal(day.total_hours, 1.5);
  assert.throws(() => store.deletePart(DATE, m.id, 0), /main entry/);
});

test('over-allocation is flagged', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha' });
  timeOn(store, clock, m.id, 30); // 0.5h
  store.addPart(DATE, m.id, { hours: 0.8 });
  const main = store.day(DATE).entries.find((e) => e.part === 0);
  assert.equal(main.hours, 0);
  assert.equal(main.over_allocated, true);
});

test('applySplit replaces parts; first item keeps the remainder', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha', code_set: 'counseling' });
  timeOn(store, clock, m.id, 120); // 2.0h
  store.addPart(DATE, m.id, { hours: 0.5, notes: 'stale' });
  const rows = store.applySplit(DATE, m.id, [
    { notes: 'analysis', narrative: 'Analyzed indemnification provisions.', hours: 1.4, task_code: 'C300', activity_code: 'A104' },
    { notes: 'email', narrative: 'Drafted email to deal team regarding same.', hours: 0.4, task_code: 'C300', activity_code: 'A105' },
    { notes: 'call', narrative: 'Telephone conference with client regarding same.', hours: 0.2, task_code: 'C300', activity_code: 'A106' },
  ]);
  assert.deepEqual(rows.map((e) => [e.part, e.hours, e.activity]), [[0, 1.4, 'A104'], [1, 0.4, 'A105'], [2, 0.2, 'A106']]);
  assert.equal(rows.some((e) => e.notes === 'stale'), false);
});

test('timestamped notes (typed and dictated) build the timeline', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha' });
  store.toggle(m.id);
  store.addNote('analysis of MAC clause');
  clock.advance(40 * MIN);
  store.addNote('starting email to team', m.id, 'dictated');
  clock.advance(10 * MIN);
  store.stop();
  const tl = store.timeline(DATE, m.id);
  assert.equal(tl.segments.length, 1);
  assert.deepEqual(tl.notes.map((n) => [n.text, n.source]), [['analysis of MAC clause', 'typed'], ['starting email to team', 'dictated']]);
  assert.equal(tl.notes[1].ts - tl.notes[0].ts, 40 * MIN);
  assert.equal(store.getEntry(DATE, m.id).notes, 'analysis of MAC clause; starting email to team');
});

test('looksBlockBilled', () => {
  const yes = [
    'Reviewed merger agreement; drafted issues list.',
    'Analyzed indemnification provisions and drafted email to team regarding same.',
    'Reviewed agreement and revised schedules.',
  ];
  const no = [
    'Reviewed and analyzed draft merger agreement.',
    'Telephone conference with client regarding merger and related matters.',
    'Drafted amended and restated credit agreement.',
    '',
  ];
  for (const n of yes) assert.equal(looksBlockBilled(n), true, n);
  for (const n of no) assert.equal(looksBlockBilled(n), false, n);
});

test('day() warns only for no-block matters', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'Strict', client_no: '9', block_billing: 'prohibited' });
  const b = store.createMatter({ name: 'Loose', client_no: '8' });
  for (const id of [a.id, b.id]) {
    timeOn(store, clock, id, 12);
    store.updateEntry(DATE, id, { narrative: 'Reviewed agreement; drafted memo.' });
  }
  const byName = Object.fromEntries(store.day(DATE).entries.map((e) => [e.matter.name, e.block_warning]));
  assert.deepEqual(byName, { Strict: true, Loose: false });
});

test('split entries export as separate lines', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha', client_no: '123456', matter_no: '00001' });
  timeOn(store, clock, m.id, 60);
  store.applySplit(DATE, m.id, [
    { narrative: 'Analyzed issue.', hours: 0.7 },
    { narrative: 'Drafted email regarding same.', hours: 0.3 },
  ]);
  const cfg = deepMerge(DEFAULTS, { timekeeper: { id: '10001' } });
  const recs = parseTim(toTim(exportable(store.day(DATE).entries), cfg));
  assert.deepEqual(recs.map((r) => [r.am, r.na]), [['2520', 'Analyzed issue.'], ['1080', 'Drafted email regarding same.']]);
  assert.notEqual(recs[0].ref, recs[1].ref);
});

test('v0.1 databases migrate to parts without losing entries', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-v1-')), 'v1.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE matters (id INTEGER PRIMARY KEY, client_no TEXT NOT NULL DEFAULT '', matter_no TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#3b82f6', task_code TEXT NOT NULL DEFAULT '', activity_code TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE entries (date TEXT NOT NULL, matter_id INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', narrative TEXT NOT NULL DEFAULT '',
      hours_override REAL, status TEXT NOT NULL DEFAULT 'draft', exported_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (date, matter_id));
    INSERT INTO matters (name, created_at) VALUES ('Legacy', 0);
    INSERT INTO entries (date, matter_id, notes, narrative, hours_override, updated_at) VALUES ('${DATE}', 1, 'old notes', 'Old narrative.', 0.4, 0);`);
  db.close();
  const store = new Store(file, () => DEFAULTS);
  const e = store.getEntry(DATE, 1, 0);
  assert.deepEqual([e.part, e.notes, e.narrative, e.hours_override], [0, 'old notes', 'Old narrative.', 0.4]);
  store.addPart(DATE, 1, { hours: 0.2 });
  assert.equal(store.day(DATE).entries.length, 2);
  store.close();
});

test('normalizeSplit snaps to increments and hits the total', () => {
  const out = normalizeSplit([{ hours: 0.93 }, { hours: 0.31 }, { hours: 0.04 }], 1.5);
  assert.deepEqual(out.map((e) => e.hours), [1.1, 0.3, 0.1]);
  assert.deepEqual(normalizeSplit([{ hours: 1 }, { hours: 1 }], 0.5).map((e) => e.hours), [0.3, 0.2]);
  assert.deepEqual(normalizeSplit([{ hours: 5 }, { hours: 5 }, { hours: 5 }], 0.2).map((e) => e.hours), [0.1, 0.1]);
});

test('proposeSplit sends guidelines + timeline and normalizes the answer', async () => {
  let body;
  const fetchImpl = async (_u, opts) => {
    body = JSON.parse(opts.body);
    const entries = [
      { notes: 'analysis', narrative: 'Analyzed MAC clause.', hours: 0.9, task_code: 'C300', activity_code: 'A104' },
      { notes: 'email', narrative: '"Drafted email to team regarding same."', hours: 0.2, task_code: 'C300', activity_code: 'A105' },
    ];
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ entries }) } }) };
  };
  const t0 = new Date(2026, 8, 29, 9, 0).getTime();
  const out = await proposeSplit({
    config: DEFAULTS,
    matter: { name: 'Alpha' },
    rules: { no_block_billing: true, guidelines: 'Separate analysis from internal emails.' },
    notes: 'analysis of MAC clause; email to team',
    timeline: { segments: [{ start_ms: t0, end_ms: t0 + 72 * MIN }], notes: [{ ts: t0 + 50 * MIN, text: 'starting email', source: 'dictated' }] },
    totalHours: 1.2,
    codes: { tasks: DEFAULTS.codes.taskSets.counseling.codes, activities: DEFAULTS.codes.activities },
    fetchImpl,
  });
  assert.deepEqual(out.map((e) => e.hours), [1, 0.2]); // snapped to sum 1.2
  assert.equal(out[1].narrative, 'Drafted email to team regarding same.');
  assert.match(body.messages[0].content, /Separate analysis from internal emails/);
  assert.match(body.messages[1].content, /\(dictated\) starting email/);
  assert.deepEqual(body.format.properties.entries.items.properties.task_code.enum, ['C100', 'C200', 'C300', 'C400']);
});

test('server: propose → apply → export warns on block-billed narratives', async () => {
  let config = deepMerge(DEFAULTS, { timekeeper: { id: '10001' } });
  const { store, clock } = setup();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: JSON.stringify({
          entries: [
            { notes: 'a', narrative: 'Analyzed issue.', hours: 0.4 },
            { notes: 'b', narrative: 'Drafted email regarding same.', hours: 0.1 },
          ],
        }),
      },
    }),
  });
  const server = createServer({ store, getConfig: () => config, setConfig: (c) => (config = c), fetchImpl, exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = {}, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const m = store.createMatter({ name: 'Strict', client_no: '222222', matter_no: '00101' });
    await post('/api/clients/222222', { no_block_billing: true, guidelines: 'No block billing.' }, 'PUT');
    timeOn(store, clock, m.id, 30);
    store.addNote('analysis; email', m.id);

    const proposal = await (await post(`/api/entries/${DATE}/${m.id}/split/propose`)).json();
    assert.equal(proposal.total_hours, 0.5);
    assert.equal(proposal.entries.length, 2);
    const applied = await (await post(`/api/entries/${DATE}/${m.id}/split/apply`, { entries: proposal.entries })).json();
    assert.deepEqual(applied.map((e) => e.hours), [0.4, 0.1]);

    // A block-billed narrative on part 1 triggers a warning that needs force.
    await post(`/api/entries/${DATE}/${m.id}/1`, { narrative: 'Drafted email; called client.' }, 'PATCH');
    let r = await post('/api/export', { date: DATE, markExported: false });
    assert.equal(r.status, 409);
    assert.match((await r.json()).warnings[0], /looks block-billed/);
    r = await post('/api/export', { date: DATE, markExported: false, force: true });
    assert.equal((await r.json()).count, 2);
  } finally {
    server.close();
    store.close();
  }
});

// ---------- Next task ----------

test('nextTask closes the current task and starts the next on the same matter', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Alpha' });
  store.toggle(m.id);
  store.addNote('analysis of MAC clause');
  clock.advance(42 * MIN);
  store.nextTask('email to deal team');
  clock.advance(9 * MIN);
  store.nextTask();
  store.addNote('call w/ GC', m.id, 'dictated');
  clock.advance(13 * MIN);
  store.stop();

  const blocks = store.taskBlocks(DATE, m.id);
  assert.deepEqual(
    blocks.map((b) => [b.task, b.ms / MIN, b.notes.map((n) => n.text)]),
    [
      [0, 42, ['analysis of MAC clause']],
      [1, 9, ['email to deal team']],
      [2, 13, ['call w/ GC']],
    ],
  );
  assert.equal(store.day(DATE).entries[0].computed_hours, 1.1); // 64 min total
  assert.throws(() => store.nextTask(), /No timer running/);
});

test('switching away and back continues the same task', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'A' });
  const b = store.createMatter({ name: 'B' });
  store.toggle(a.id);
  clock.advance(10 * MIN);
  store.nextTask();
  clock.advance(5 * MIN);
  store.toggle(b.id); // short interruption on another matter
  clock.advance(10 * MIN);
  store.toggle(a.id); // back to A: still task 1
  clock.advance(5 * MIN);
  store.stop();
  assert.deepEqual(store.taskBlocks(DATE, a.id).map((x) => [x.task, x.ms / MIN]), [[0, 10], [1, 10]]);
  assert.deepEqual(store.taskBlocks(DATE, b.id).map((x) => x.task), [0]);
});

test('state reports the running task count', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'A' });
  store.toggle(m.id);
  clock.advance(MIN);
  store.nextTask();
  assert.equal(store.state().running.tasks_today, 2);
});

test('server: marked tasks give an exact split; model only writes narratives', async () => {
  let config = deepMerge(DEFAULTS, { timekeeper: { id: '10001' } });
  const { store, clock } = setup();
  const calls = [];
  const fetchImpl = async (_u, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const notes = body.messages.at(-1).content.match(/Notes: (.*)/)?.[1] ?? '';
    return { ok: true, json: async () => ({ message: { content: `Narrative for ${notes}.` } }) };
  };
  const server = createServer({ store, getConfig: () => config, setConfig: (c) => (config = c), fetchImpl, exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const m = store.createMatter({ name: 'Strict', client_no: '1', matter_no: '1', block_billing: 'prohibited' });
    store.toggle(m.id);
    store.addNote('analysis');
    clock.advance(42 * MIN);
    assert.equal((await post('/api/timer/next-task', { label: 'email' })).status, 200);
    clock.advance(9 * MIN);
    await post('/api/timer/next-task', { label: 'call' });
    clock.advance(13 * MIN);
    store.stop();

    const p = await (await post(`/api/entries/${DATE}/${m.id}/split/propose`)).json();
    assert.equal(p.mode, 'tasks');
    assert.equal(p.total_hours, 1.1);
    assert.deepEqual(p.entries.map((e) => [e.notes, e.hours, e.narrative]), [
      ['analysis', 0.7, 'Narrative for analysis.'],
      ['email', 0.2, 'Narrative for email.'],
      ['call', 0.2, 'Narrative for call.'],
    ]);
    assert.equal(calls.length, 3); // one narrative per task, no split-guessing call
  } finally {
    server.close();
    store.close();
  }
});

test('normalizeSplit gives short tasks their fair tenth (largest remainder)', () => {
  // 42 / 9 / 13 minutes of a 1.1h day
  const out = normalizeSplit([{ hours: 42 / 60 }, { hours: 9 / 60 }, { hours: 13 / 60 }], 1.1);
  assert.deepEqual(out.map((e) => e.hours), [0.7, 0.2, 0.2]);
});

test('applying a split whose total exceeds the timer pins the main entry', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'Quick' });
  timeOn(store, clock, m.id, 5); // 0.1h on the timer
  const rows = store.applySplit(DATE, m.id, [
    { narrative: 'Reviewed.', hours: 0.1 },
    { narrative: 'Emailed.', hours: 0.1 },
    { narrative: 'Called.', hours: 0.1 },
  ]);
  assert.deepEqual(rows.map((e) => e.hours), [0.1, 0.1, 0.1]);
  assert.equal(rows[0].over_allocated, false);
});

test('coming back to a matter after a long gap starts a new task', () => {
  const { store, clock } = setup();
  const a = store.createMatter({ name: 'A' });
  timeOn(store, clock, a.id, 30); // morning: task 0
  clock.advance(3 * 60 * MIN); // afternoon
  timeOn(store, clock, a.id, 20); // new work: task 1
  clock.advance(5 * MIN);
  timeOn(store, clock, a.id, 10); // back after 5 minutes: still task 1
  assert.deepEqual(store.taskBlocks(DATE, a.id).map((x) => [x.task, x.ms / MIN]), [[0, 30], [1, 30]]);
});

test('a dictated note belongs to the task it was spoken in, even if transcribed after Next task', () => {
  const { store, clock } = setup();
  const m = store.createMatter({ name: 'A' });
  store.toggle(m.id);
  const spokeAt = clock.now();
  clock.advance(10 * MIN);
  store.nextTask(); // pressed while transcription was still running
  clock.advance(MIN);
  store.addNote('reviewed disclosure schedules', m.id, 'dictated', spokeAt);
  clock.advance(5 * MIN);
  store.stop();
  assert.deepEqual(store.taskBlocks(DATE, m.id).map((b) => b.notes.map((n) => n.text)), [['reviewed disclosure schedules'], []]);
});

// ---------- Stream Deck layout ----------

test('deck defaults to first matters, then Dictate / Next task / Stop', () => {
  const { store } = setup();
  for (const n of ['Alpha', 'Beta', 'Firm Admin (non-billable)']) store.createMatter({ name: n });
  const deck = store.deck();
  assert.equal(deck.length, 8);
  assert.deepEqual(deck.map((s) => s.kind), ['matter', 'matter', 'empty', 'empty', 'empty', 'dictate', 'next-task', 'stop']);
  assert.deepEqual(deck.slice(0, 2).map((s) => store.getMatter(s.matter_id).name), ['Alpha', 'Beta']);
});

test('placing a matter moves it; swap exchanges keys; archive clears its key', () => {
  const { store } = setup();
  const a = store.createMatter({ name: 'Alpha' });
  const b = store.createMatter({ name: 'Beta' });
  store.setDeckSlot(3, { kind: 'matter', matter_id: a.id }); // was on key 0
  let deck = store.deck();
  assert.equal(deck[0].kind, 'empty');
  assert.equal(deck[3].matter_id, a.id);
  store.swapDeckSlots(1, 3);
  deck = store.deck();
  assert.deepEqual([deck[1].matter_id, deck[3].matter_id], [a.id, b.id]);
  store.setDeckSlot(7, { kind: 'review' });
  assert.equal(store.deck()[7].kind, 'review');
  store.updateMatter(a.id, { archived: 1 });
  assert.equal(store.deck()[1].kind, 'empty');
  assert.throws(() => store.setDeckSlot(9, { kind: 'stop' }), /No such key/);
  assert.throws(() => store.setDeckSlot(0, { kind: 'matter', matter_id: a.id }), /active matter/);
  assert.equal(store.state().deck.length, 8);
});
