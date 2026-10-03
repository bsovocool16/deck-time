import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { DEMO_CORRECTIONS } from '../src/demo-seed.js';
import { draftNarrative } from '../src/drafter.js';
import { Phrasebook } from '../src/phrasebook.js';
import { Teacher, checkRule, replay, wordDistance } from '../src/teacher.js';

// A fake local model that answers with the given rules.
const model = (rules) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ rules }) } }) };
  };
  return { fetchImpl, calls };
};

function setup(rules, { file = null } = {}) {
  let teacher;
  const phrasebook = new Phrasebook({ taught: () => teacher.rules() });
  phrasebook.corrections = DEMO_CORRECTIONS.map((c) => ({ ...c }));
  phrasebook.rebuild();
  const m = model(rules);
  teacher = new Teacher({ file, phrasebook, getConfig: () => DEFAULTS, fetchImpl: m.fetchImpl });
  return { teacher, phrasebook, calls: m.calls };
}

const why = (t, from) => t.status().lastRun.dropped.find((d) => d.from === from)?.why;

test('wordDistance ignores case and punctuation', () => {
  assert.equal(wordDistance('Redline credit agreement.', 'redlined credit agreement'), 1);
  assert.equal(wordDistance('A b c', 'a b c.'), 0);
});

test('teacher keeps rules the replay supports and drops the rest, with reasons', async () => {
  const { teacher, calls } = setup([
    { type: 'verb', from: 'redline', to: 'redlined', scope: 'everywhere', reason: 'Redline is a verb.' },
    { type: 'phrase', from: 'cp', to: 'conditions precedent', scope: 'everywhere', reason: 'CP on the loan.' },
    { type: 'fix', from: 'Reviewed', to: 'Analyzed', scope: 'matter 30877.0015', reason: 'One rewrite.' },
    { type: 'phrase', from: 'mtd', to: 'motion to strike', scope: 'everywhere', reason: 'Invented.' },
    { type: 'fix', from: 'board deck', to: 'board presentation', scope: 'everywhere', reason: 'Stark.' },
  ]);
  const s = await teacher.run();
  // Only edits the plain drafter still gets wrong are shown to the model, sent to the local Ollama.
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:11434\/api\/chat$/);
  assert.match(calls[0].body.messages[1].content, /NOTES: redline engagement letter/);
  assert.equal(calls[0].body.options.temperature, 0);

  const kept = Object.fromEntries(s.proposals.map((p) => [p.from, p]));
  assert.equal(kept.redline.matter, undefined); // fixed drafts on two matters: everywhere
  assert.deepEqual(kept.redline.evidence.matters.sort(), ['20411.0002', '52009.0004']);
  assert.equal(kept.cp.matter, '20411.0002'); // only ever on the loan: narrowed to it
  assert.equal(kept['board deck'].matter, '41120.0001');
  assert.equal(why(teacher, 'Reviewed'), 'only one past draft supports it');
  assert.match(why(teacher, 'mtd'), /adds words you never used \(strike\)/);
});

test('a rule that would make any past draft worse is dropped', async () => {
  // "agreement" -> "credit agreement" helps nowhere and hurts the Acme draft about the SPA.
  const { teacher } = setup([{ type: 'fix', from: 'agreement', to: 'credit agreement', scope: 'everywhere', reason: 'x' }]);
  await teacher.run();
  assert.match(why(teacher, 'agreement'), /worse/);
});

test('accepting a rule changes the next draft; rejected and removed rules are not proposed again', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-')), 'teacher.json');
  const rules = [{ type: 'verb', from: 'redline', to: 'redlined', scope: 'everywhere', reason: 'Verb.' }];
  const { teacher, phrasebook } = setup(rules, { file });
  await teacher.run();
  const [p] = teacher.status().proposals;
  assert.equal(draftNarrative('redline the nda', phrasebook.options('99999.0000')), 'Redline the NDA.');
  teacher.decide(p.id, 'accept');
  assert.equal(draftNarrative('redline the nda', phrasebook.options('99999.0000')), 'Redlined the NDA.');
  assert.equal(draftNarrative('review nda redline spa', phrasebook.options('99999.0000')), 'Reviewed NDA and redlined stock purchase agreement.');

  // Saved, and survives a restart.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rules[0].from, 'redline');

  teacher.remove(teacher.rules()[0].id);
  assert.equal(teacher.rules().length, 0);
  await teacher.run();
  assert.equal(teacher.status().proposals.length, 0);
  assert.equal(why(teacher, 'redline'), 'already accepted or rejected');
});

test('teacher needs a few edits, and says so', async () => {
  const phrasebook = new Phrasebook();
  const teacher = new Teacher({ phrasebook, getConfig: () => DEFAULTS, fetchImpl: model([]).fetchImpl });
  assert.equal(teacher.status().ready, false);
  await assert.rejects(teacher.run(), /Export a few entries/);
});

test('checkRule: verbs are single unknown words; rules only use words you billed', () => {
  const finals = ['Redlined credit agreement.'];
  assert.equal(checkRule({ type: 'verb', from: 'review', to: 'reviewed' }, { finals: ['reviewed'] }), 'already a known verb');
  assert.equal(checkRule({ type: 'verb', from: 'mark up', to: 'redlined' }, { finals }), 'a verb is one word');
  assert.equal(checkRule({ type: 'verb', from: 'redline', to: 'redlined' }, { finals }), null);
  assert.match(checkRule({ type: 'fix', from: 'x', to: 'merger agreement' }, { finals }), /merger/);
});

test('replay compares against the plain drafter, so general rules get credit for narrow learned fixes', () => {
  const phrasebook = new Phrasebook();
  phrasebook.corrections = DEMO_CORRECTIONS;
  phrasebook.rebuild();
  // The phrasebook already patches "Redline engagement" on its own; the verb rule still counts both edits.
  const r = replay(phrasebook, DEMO_CORRECTIONS, { type: 'verb', from: 'redline', to: 'redlined' });
  assert.equal(r.improved, 2);
  assert.equal(r.worsened, 0);
});

test('every edit is logged with its notes, even when the phrasebook learns nothing from it', () => {
  const phrasebook = new Phrasebook();
  phrasebook.addCorrection({ draft: 'Reviewed agreement.', final: 'Reviewed agreement and sent comments.', notes: 'rev agmt', matter: '1.1' });
  phrasebook.addCorrection({ draft: 'Same.', final: 'Same.', matter: '1.1' }); // unchanged: not an edit
  assert.equal(phrasebook.corrections.length, 1);
  assert.equal(phrasebook.corrections[0].notes, 'rev agmt');
});

// ---------- undo counts against what was learned ----------

test('phrasebook: undoing a learned change cancels it instead of learning the opposite', () => {
  let t = Date.UTC(2026, 9, 1);
  const pb = new Phrasebook({ now: () => t });
  const m = '30877.0015';
  // One rewrite teaches "Reviewed" -> "Analyzed" on this matter...
  pb.addCorrection({ draft: 'Reviewed opposition brief.', final: 'Analyzed opposition brief.', notes: 'rev opp brief', matter: m, at: t });
  assert.equal(draftNarrative('rev reply brief', pb.options(m)), 'Analyzed reply brief.');
  // ...you put "Reviewed" back on the next one: the learned change is off, and no reverse rule appears.
  pb.addCorrection({ draft: 'Analyzed reply brief.', final: 'Reviewed reply brief.', notes: 'rev reply brief', matter: m, at: t + 1000 });
  assert.equal(draftNarrative('rev sur-reply', pb.options(m)), 'Reviewed sur-reply.');
  assert.equal(draftNarrative('analyze damages model', pb.options(m)), 'Analyzed damages model.');
  const row = pb.list().find((r) => r.from === 'Reviewed');
  assert.equal(row.undone, 1);
  assert.equal(pb.stats().undone, 1);

  // Value-neutral: if you then make the change twice more, it comes back.
  pb.addCorrection({ draft: 'Reviewed expert report.', final: 'Analyzed expert report.', notes: 'rev expert report', matter: m, at: t + 2000 });
  pb.addCorrection({ draft: 'Reviewed deposition outline.', final: 'Analyzed deposition outline.', notes: 'rev depo outline', matter: m, at: t + 3000 });
  assert.equal(draftNarrative('rev motion', pb.options(m)), 'Analyzed motion.');
});

test('teacher rules turn themselves off once you undo them more than you keep them', async () => {
  const { teacher, phrasebook } = setup([{ type: 'verb', from: 'redline', to: 'redlined', scope: 'everywhere', reason: 'Verb.' }]);
  await teacher.run();
  teacher.decide(teacher.status().proposals[0].id, 'accept');
  const later = (notes, final, n) => phrasebook.addCorrection({ notes, draft: draftNarrative(notes, phrasebook.options('1.1')), final, matter: '1.1', at: Date.now() + n });
  const rule = () => teacher.status().rules[0];

  later('redline the nda', 'Redline the NDA.', 1); // undone once: accepting still outweighs it
  assert.deepEqual([rule().kept, rule().undone, rule().active], [0, 1, true]);
  later('redline side letter', 'Redline side letter.', 2); // undone twice, never kept: off
  assert.deepEqual([rule().undone, rule().active], [2, false]);
  assert.equal(teacher.rules().length, 0);
  assert.equal(draftNarrative('redline the spa', phrasebook.options('1.1', [], { learned: false })), 'Redline the stock purchase agreement.');

  later('redline escrow agmt', 'Redlined escrow agreement.', 3); // kept once more: 1 kept + acceptance vs 2 undone
  assert.deepEqual([rule().kept, rule().undone, rule().active], [1, 2, true]);
});

test('phrasebook: a change made twice on one matter stays on that matter; on two matters it applies everywhere', () => {
  const pb = new Phrasebook();
  pb.corrections = DEMO_CORRECTIONS;
  pb.rebuild();
  const row = (from) => pb.list().find((r) => r.from === from);
  assert.equal(row('deal team').everywhere, false); // both edits on Acme
  assert.deepEqual(row('deal team').matters, ['10234.0007']);
  assert.equal(draftNarrative('email deal team', pb.options('20411.0002')), 'Emailed deal team.');
  pb.addCorrection({ draft: 'Emailed deal team.', final: 'Emailed working group.', notes: 'email deal team', matter: '20411.0002' });
  assert.equal(row('deal team').everywhere, true);
});
