import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodeMemory, codeSetOf, examplesFromTim, ruleCodes, tokenize } from '../src/coder.js';
import { DEFAULTS } from '../src/config.js';
import { parseTim } from '../src/export.js';

const counseling = { tasks: DEFAULTS.codes.taskSets.counseling.codes, activities: DEFAULTS.codes.activities };
const litigation = { tasks: DEFAULTS.codes.taskSets.litigation.codes, activities: DEFAULTS.codes.activities };

test('keyword rules cover the common cases instantly', () => {
  const cases = [
    ['Telephone conference with client general counsel regarding IP licensing.', counseling, 'C300', 'A106'],
    ['Conference call with opposing counsel regarding NDA comments.', counseling, 'C400', 'A107'],
    ['Drafted email to deal team summarizing analysis.', counseling, 'C300', 'A103'],
    ['Researched Delaware case law regarding appraisal rights.', counseling, 'C200', 'A102'],
    ['Reviewed and analyzed draft merger agreement.', counseling, 'C300', 'A104'],
    ['Drafted responses to second set of interrogatories.', litigation, 'L310', 'A103'],
    ['Reviewed document production for privilege issues.', litigation, 'L320', 'A104'],
  ];
  for (const [text, codes, task, activity] of cases) assert.deepEqual(ruleCodes(text, codes), { task_code: task, activity_code: activity }, text);
});

test('tokenize keeps meaningful words and pairs', () => {
  const t = tokenize('Telephone conference with client regarding the earnout.');
  assert.ok(t.includes('client'));
  assert.ok(t.includes('earnout'));
  assert.ok(t.includes('telephone_conference'));
  assert.equal(t.includes('the'), false);
});

function history(n) {
  // A coding habit the rules don't know: this user codes deal-team emails as A105 (in firm).
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ source: 'export', matter: '10234.0007', code_set: 'counseling', narrative: `Emailed deal team regarding schedule ${i} comments.`, task: 'C300', activity: 'A105' });
    out.push({ source: 'export', matter: '10234.0007', code_set: 'counseling', narrative: `Reviewed draft agreement section ${i}.`, task: 'C300', activity: 'A104' });
    out.push({ source: 'export', matter: '20411.0002', code_set: 'counseling', narrative: `Telephone conference with client CFO regarding covenant ${i}.`, task: 'C300', activity: 'A106' });
  }
  return out;
}

test('with enough history, learned codes override the rules', () => {
  const memory = new CodeMemory();
  const text = 'Emailed deal team regarding open issues.';
  assert.equal(memory.suggest(text, counseling).activity_code, 'A103'); // rules: email -> drafting
  memory.add(history(8));
  const s = memory.suggest(text, counseling, { codeSet: 'counseling', matter: '10234.0007' });
  assert.equal(s.activity_code, 'A105');
  assert.notEqual(s.source.activity, 'rules');
});

test('too little history falls back to rules', () => {
  const memory = new CodeMemory();
  memory.add(history(1));
  const s = memory.suggest('Emailed deal team regarding open issues.', counseling, { codeSet: 'counseling' });
  assert.equal(s.source.activity, 'rules');
});

test('memory persists to a JSONL log, skips duplicates, and survives a damaged line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mem-')), 'code-memory.jsonl');
  const a = new CodeMemory(file);
  const ex = { source: 'import', ref: 'r1', narrative: 'Reviewed SPA.', task: 'C300', activity: 'A104' };
  assert.equal(a.add([ex, ex]), 1);
  fs.appendFileSync(file, '{not json\n');
  const b = new CodeMemory(file);
  assert.equal(b.stats().examples, 1);
  assert.equal(b.add([ex]), 0);
});

test('Intapp .TIM exports become training examples', () => {
  const sample = fs.readFileSync(new URL('../../docs/samples/intapp-export-coded.example.tim', import.meta.url), 'utf8');
  const ex = examplesFromTim(parseTim(sample));
  assert.equal(ex.length, 1);
  assert.deepEqual([ex[0].task, ex[0].activity, ex[0].code_set, ex[0].matter], ['C300', 'A104', 'counseling', '222222.00101']);
  assert.equal(codeSetOf('L120'), 'litigation');
});

test('suggestions are fast', () => {
  const memory = new CodeMemory();
  memory.add(history(300)); // 900 examples
  const t = performance.now();
  for (let i = 0; i < 100; i++) memory.suggest('Telephone conference with client regarding covenant headroom.', counseling, { codeSet: 'counseling', matter: '20411.0002' });
  assert.ok((performance.now() - t) / 100 < 5, 'under 5 ms per suggestion');
});
