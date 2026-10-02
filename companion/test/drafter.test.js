import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { draftClauses, draftNarrative } from '../src/drafter.js';
import { learnFromEdit, parseCustom, Phrasebook } from '../src/phrasebook.js';

test('instant drafts from shorthand and dictation', () => {
  const cases = [
    ['prepare officer cert send to client', "Prepared officer's certificate and sent to client."],
    ['prepare officer cert and send to client', "Prepared officer's certificate and sent to client."],
    ['call w/ client GC re IP licensing', 'Telephone conference with client general counsel regarding IP licensing.'],
    ['tc w/ opp counsel re NDA markup; revised draft', 'Telephone conference with opposing counsel regarding NDA markup; revised draft.'],
    ['rev discl scheds; email to deal team re open issues', 'Reviewed disclosure schedules; emailed deal team regarding open issues.'],
    ['Reviewing the target disclosure schedules against the reps in the merger agreement', 'Reviewed the target disclosure schedules against the reps in the merger agreement.'],
    ['Call with opposing counsel about the closing conditions', 'Telephone conference with opposing counsel regarding the closing conditions.'],
    ['drafted responses to second set of rogs', 'Drafted responses to second set of interrogatories.'],
    ['review draft SPA, send comments to opp counsel', 'Reviewed draft stock purchase agreement and sent comments to opposing counsel.'],
    ['mtg w/ BOD re sale process; prep resos and sig pages', 'Meeting with board of directors regarding sale process; prepared resolutions and signature pages.'],
    ['finalize closing ckl and circulate sig pages to working group', 'Finalized closing checklist and circulated signature pages to working group.'],
  ];
  for (const [notes, want] of cases) assert.equal(draftNarrative(notes), want, notes);
});

test('drafting never adds words that are not in the notes (beyond shorthand and verb tense)', () => {
  const notes = 'review Pied Piper term sheet';
  const out = draftNarrative(notes);
  assert.equal(out, 'Reviewed Pied Piper term sheet.');
});

test('a verb after a preposition or article is not a new action', () => {
  assert.equal(draftNarrative('send draft to client for review'), 'Sent draft to client for review.');
  assert.equal(draftNarrative('comments to the draft'), 'Comments to the draft.');
});

test('custom shorthand overrides the built-ins', () => {
  const phrases = parseCustom("pike = Project Pike\n# comment\nscheds => disclosure schedules (Pike)");
  assert.equal(draftNarrative('rev pike scheds', { phrases }), 'Reviewed Project Pike disclosure schedules (Pike).');
});

test('clauses split for one-entry-per-task', () => {
  assert.deepEqual(draftClauses('analyze MAC; email deal team re same').map((c) => c.narrative), ['Analyzed MAC.', 'Emailed deal team regarding same.']);
});

test('learnFromEdit finds the phrase you changed, with context for one-word edits', () => {
  assert.deepEqual(learnFromEdit('Prepared officer certificate and sent to client.', "Prepared officer's certificate and sent to client."), [
    { from: 'officer certificate', to: "officer's certificate" },
  ]);
  assert.deepEqual(learnFromEdit('Reviewed agreement.', 'Reviewed agreement.'), []);
  assert.deepEqual(learnFromEdit('Reviewed Agreement.', 'Reviewed agreement.'), []); // case-only
  assert.deepEqual(learnFromEdit('A b c d e f g.', 'Completely different text that was rewritten from scratch entirely now.').length, 0);
});

test('a correction applies on its matter at once; elsewhere only after it recurs', () => {
  let t = Date.parse('2026-10-02T12:00:00');
  const pb = new Phrasebook({ now: () => t });
  const edit = { draft: 'Telephone conference with client regarding deck.', final: 'Telephone conference with client regarding board presentation.' };
  pb.addCorrection({ ...edit, matter: 'A' });
  assert.equal(pb.options('A').fix('Call; regarding deck.'), 'Call; regarding board presentation.');
  assert.equal(pb.options('B').fix('Call; regarding deck.'), 'Call; regarding deck.');
  pb.addCorrection({ ...edit, matter: 'C' });
  assert.equal(pb.options('B').fix('Call; regarding deck.'), 'Call; regarding board presentation.');
});

test('old corrections fade (45-day half-life)', () => {
  let t = Date.parse('2026-01-01T12:00:00');
  const pb = new Phrasebook({ now: () => t });
  pb.addCorrection({ draft: 'Reviewed deck.', final: 'Reviewed presentation.', matter: 'A', at: t });
  assert.equal(pb.options('A').fix('Reviewed deck.'), 'Reviewed presentation.');
  t += 90 * 86_400_000; // two half-lives later
  pb.rebuild();
  assert.equal(pb.options('A').fix('Reviewed deck.'), 'Reviewed deck.');
});

test('the phrasebook log persists and feeds Whisper vocabulary', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-pb-')), 'corrections.jsonl');
  const corpus = Array.from({ length: 4 }, () => ({ narrative: "Prepared officer's certificate and bring-down certificate." }));
  const a = new Phrasebook({ file, custom: () => 'pike = Project Pike', corpus: () => corpus });
  a.addCorrection({ draft: 'Prepared officer certificate.', final: "Prepared officer's certificate.", matter: 'A' });
  const b = new Phrasebook({ file, custom: () => 'pike = Project Pike', corpus: () => corpus });
  assert.equal(b.stats().corrections, 1);
  const vocab = b.vocabulary();
  assert.ok(vocab.includes('Project Pike'));
  assert.ok(vocab.includes("officer's certificate"));
});

test('drafting is fast', () => {
  const t = performance.now();
  for (let i = 0; i < 500; i++) draftNarrative('prepare officer cert send to client; tc w/ opp counsel re NDA markup; rev discl scheds');
  assert.ok((performance.now() - t) / 500 < 2, 'under 2 ms per draft');
});
