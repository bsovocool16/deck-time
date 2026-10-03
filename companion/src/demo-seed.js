// Fictional matters and a sample day, for showing deck-time to people without
// real client data on screen. Used by the "Demo day" switch and `npm run demo`.

import { draftNarrative } from './drafter.js';

const MIN = 60_000;
const DAY = 86_400_000;

// Fictional edits for demo day's teacher (Settings → Teacher): notes, the
// instant draft, and what the "lawyer" billed instead. Patterns worth a rule:
// "cp" means conditions precedent on the loan; "redline" is a verb; Stark
// calls it a board presentation; Acme's deal team is the working group. The
// last one is a one-off rewrite the teacher should leave alone.
const DEMO_EDITS = [
  ['20411.0002', 'update cp checklist and circulate to lender counsel', 'Updated conditions precedent checklist and circulated to lender counsel.'],
  ['20411.0002', 'rev borrower cp deliverables', 'Reviewed borrower conditions precedent deliverables.'],
  ['20411.0002', 'redline credit agmt per lender comments', 'Redlined credit agreement per lender comments.'],
  ['52009.0004', 'redline engagement letter', 'Redlined engagement letter.'],
  ['41120.0001', 'prepare board deck for stark mtg', 'Prepared board presentation for Stark meeting.'],
  ['41120.0001', 'revise board deck per client comments', 'Revised board presentation per client comments.'],
  ['10234.0007', 'email deal team re open points on spa', 'Emailed working group regarding open points on stock purchase agreement.'],
  ['10234.0007', 'call w/ deal team re signing logistics', 'Telephone conference with working group regarding signing logistics.'],
  ['30877.0015', 'rev hooli opp to mtd', 'Analyzed Hooli opposition to motion to dismiss and outlined reply arguments.'],
];

export const DEMO_CORRECTIONS = DEMO_EDITS.map(([matter, notes, final], i) => ({
  at: Date.now() - (DEMO_EDITS.length - i) * DAY,
  matter,
  notes,
  draft: draftNarrative(notes),
  final,
}));

const MATTERS = [
  { name: 'Acme / Globex Merger', label: 'Acme M&A', client_no: '10234', matter_no: '0007', color: '#2f5d8a' }, // M&A: no task codes
  { name: 'Initech Credit Facility', label: 'Initech Loan', client_no: '20411', matter_no: '0002', color: '#3f7d52' },
  { name: 'Umbrella v. Hooli', label: 'Umbrella Lit.', client_no: '30877', matter_no: '0015', color: '#9a3b36', code_set: 'litigation' },
  { name: 'Stark Industries Board', label: 'Stark Board', client_no: '41120', matter_no: '0001', color: '#6b4f8a' },
  { name: 'Wayne Ent. Fairness Opinion', label: 'Wayne FO', client_no: '52009', matter_no: '0004', color: '#b0702a' },
  { name: 'Firm Admin (non-billable)', label: 'Admin', client_no: '99999', matter_no: '0000', color: '#7a7a74' },
];

/** Create the fictional matters (once) and, if today is empty, a sample morning. */
export function seedDemo(store, now = store.now()) {
  if (!store.listMatters({ includeArchived: true }).length) {
    for (const m of MATTERS) store.createMatter(m);
    store.updateClient('10234', {
      name: 'Acme Corp',
      no_block_billing: true,
      guidelines: 'Separate legal analysis, the internal email reporting that analysis, and any call about it into distinct entries.',
    });
    store.updateClient('30877', { name: 'Umbrella Corp', guidelines: 'UTBMS litigation codes required on every entry.' });
  }

  // The sample morning spans ~4 hours. Early in the day, squeeze it into the time
  // since midnight so it always lands on today (e.g. a retake at 1 am).
  const sinceMidnight = (now - new Date(now).setHours(0, 0, 0, 0)) / MIN;
  const squeeze = sinceMidnight < 245 ? Math.max(0.05, (sinceMidnight - 5) / 240) : 1;
  const at = (minAgo) => now - minAgo * MIN * squeeze;
  if (store.segmentsForDay(localDay(now)).length) return; // today already has time

  const byName = Object.fromEntries(store.listMatters().map((m) => [m.label, m]));
  const seg = (label, from, to, task = 0) => store.addSegment({ matter_id: byName[label].id, start_ms: at(from), end_ms: at(to), task });
  const note = (label, minAgo, text) => store.addNote(text, byName[label].id, 'dictated', at(minAgo));

  seg('Stark Board', 232, 200);
  note('Stark Board', 231, 'rev draft board minutes; comments to GC');
  store.updateEntry(localDay(at(231)), byName['Stark Board'].id, {
    narrative: 'Reviewed draft board minutes and provided comments to general counsel.',
    status: 'ready',
  });

  seg('Initech Loan', 192, 151);
  note('Initech Loan', 190, 'rev lender comments to credit agmt; issues list for client');

  // Three tasks marked with Next task: analysis, internal email, client call.
  seg('Acme M&A', 140, 96, 0);
  seg('Acme M&A', 96, 83, 1);
  seg('Acme M&A', 83, 71, 2);
  note('Acme M&A', 139, 'analyzed MAC clause and termination rights in merger agmt');
  note('Acme M&A', 96, 'email to deal team summarizing MAC analysis');
  note('Acme M&A', 83, 'call w/ client GC re same');

  seg('Umbrella Lit.', 62, 24);
  note('Umbrella Lit.', 61, 'drafted responses to second set of interrogatories');
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
