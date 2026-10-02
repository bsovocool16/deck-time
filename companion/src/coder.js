// Instant task/activity codes with no AI model.
//
// 1. Keyword rules give a sensible answer from day one.
// 2. A code memory learns from your own history: every export (and any past
//    Intapp .TIM files you import) adds narrative + codes examples to a small
//    JSONL log; a word-frequency table built from that log (naive Bayes)
//    predicts codes for new narratives, weighting the same matter's history.
//    It takes over from the rules once it's confident.
//
// The whole thing is a few kilobytes in memory and answers in about a millisecond.

import fs from 'node:fs';

// ---------- text ----------

const STOP = new Set(
  'a an the of to and or for with on in at by from re regarding same this that these those its it is was were be been as into per via about his her their our my your'.split(' '),
);

/** Lowercase words, crude stemming, stopwords out, plus adjacent-word pairs. */
export function tokenize(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w));
  const pairs = words.slice(1).map((w, i) => `${words[i]}_${w}`);
  return [...words, ...pairs];
}

// ---------- 1. keyword rules ----------

/** Best-guess codes from keywords. Always answers (falls back to the commonest codes). */
export function ruleCodes(text, codes) {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  const has = (re) => re.test(t);
  const call = has(/telephone|\bcall|conference|meeting|\bmet with|zoom|teams/);

  // What the entry is doing is usually its opening verb ("Reviewed … draft agreement" is review, not drafting).
  const lead = t.trim().split(/\s+/)[0] ?? '';
  const leads = (re) => re.test(lead);

  let activity = 'A104';
  if (call) activity = has(/client|general counsel|\bgc\b|chief|\bceo|\bcfo|committee|board/) ? 'A106' : has(/counsel|attorney|lawyer/) ? 'A107' : 'A108';
  else if (leads(/^(review|analy|evaluat|consider|assess|examin)/)) activity = 'A104';
  else if (leads(/^research/)) activity = 'A102';
  else if (leads(/^(draft|revis|prepar|wrote|writ|mark|edit|finaliz|email|e-mail|sent|circulat|respond)/) || has(/\b(drafted|drafting|emailed|email to|e-mail to)\b/)) activity = 'A103';
  else if (has(/research/)) activity = 'A102';
  else if (has(/attend|appear|hearing|deposition/)) activity = 'A109';
  else if (has(/organiz|file management|database|upload/)) activity = 'A110';

  const tasks = Object.keys(codes.tasks);
  let task;
  if (tasks[0]?.startsWith('L')) {
    task = has(/interrogator|requests? for admission/) ? 'L310'
      : has(/document production|produc|privilege/) ? 'L320'
      : has(/deposition/) ? 'L330'
      : has(/expert/) ? 'L340'
      : has(/meet and confer|deficienc/) ? 'L390'
      : has(/motion to dismiss|summary judgment|dispositive/) ? 'L240'
      : has(/motion|brief/) ? 'L250'
      : has(/complaint|answer|pleading/) ? 'L210'
      : has(/settle|mediat/) ? 'L160'
      : has(/trial/) ? 'L440'
      : has(/appeal|appellate/) ? 'L520'
      : 'L120';
  } else {
    task = has(/research/) ? 'C200'
      : has(/gather|collect|fact/) ? 'C100'
      : call && has(/opposing|counterparty|bank|lender|regulator|third party|counsel to/) ? 'C400'
      : 'C300';
  }
  return {
    task_code: tasks.includes(task) ? task : tasks[0],
    activity_code: activity in codes.activities ? activity : Object.keys(codes.activities)[0],
  };
}

// ---------- 2. code memory ----------

/** Which code set a task code belongs to, judged by its letter. */
export function codeSetOf(taskCode) {
  return /^L/i.test(taskCode) ? 'litigation' : /^C/i.test(taskCode) ? 'counseling' : /^[A-Z]/i.test(taskCode) ? taskCode[0].toUpperCase() : null;
}

const SAME_MATTER_WEIGHT = 3;

/** Word-frequency table for one field (task or activity). */
function emptyTable() {
  return { docs: new Map(), words: new Map(), totals: new Map(), n: 0, vocab: new Set() };
}

function addExample(table, label, tokens, weight = 1) {
  table.n += weight;
  table.docs.set(label, (table.docs.get(label) ?? 0) + weight);
  let counts = table.words.get(label);
  if (!counts) table.words.set(label, (counts = new Map()));
  for (const tok of tokens) {
    counts.set(tok, (counts.get(tok) ?? 0) + weight);
    table.totals.set(label, (table.totals.get(label) ?? 0) + weight);
    table.vocab.add(tok);
  }
}

/** Naive Bayes over the table, restricted to allowed labels. Returns { code, confidence, examples } or null. */
function classify(table, tokens, allowed) {
  if (!table || table.n === 0) return null;
  const labels = allowed.filter((l) => table.docs.has(l));
  if (!labels.length) return null;
  const V = table.vocab.size + 1;
  const scores = labels.map((label) => {
    const counts = table.words.get(label);
    const total = table.totals.get(label) ?? 0;
    let s = Math.log((table.docs.get(label) + 1) / (table.n + allowed.length));
    for (const tok of tokens) s += Math.log(((counts.get(tok) ?? 0) + 1) / (total + V));
    return { label, s };
  });
  scores.sort((a, b) => b.s - a.s);
  const max = scores[0].s;
  const z = scores.reduce((sum, x) => sum + Math.exp(x.s - max), 0);
  return { code: scores[0].label, confidence: 1 / z, examples: table.n };
}

export class CodeMemory {
  /** file: path to the JSONL log (null = in memory only, for tests). */
  constructor(file = null) {
    this.file = file;
    this.examples = [];
    this.refs = new Set();
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.#keep(JSON.parse(line));
        } catch {
          // skip a damaged line rather than losing the rest
        }
      }
    }
    this.rebuild();
  }

  #keep(ex) {
    if (ex.ref && this.refs.has(ex.ref)) return false;
    if (!ex.narrative || !(ex.task || ex.activity)) return false;
    if (ex.ref) this.refs.add(ex.ref);
    this.examples.push(ex);
    return true;
  }

  /** Add examples (from an export or an import); appends to the log and relearns. Returns how many were new. */
  add(examples) {
    const fresh = examples.filter((ex) => this.#keep(ex));
    if (fresh.length && this.file) fs.appendFileSync(this.file, fresh.map((ex) => JSON.stringify(ex)).join('\n') + '\n');
    if (fresh.length) this.rebuild();
    return fresh.length;
  }

  /** Consolidation: rebuild the word tables from the full log (fast; thousands of examples in milliseconds). */
  rebuild() {
    this.task = new Map(); // code set -> table
    this.activity = emptyTable();
    this.byMatter = new Map(); // "client.matter" -> { task, activity } tables, for same-matter weighting
    for (const ex of this.examples) {
      const tokens = tokenize(ex.narrative);
      const set = ex.code_set || codeSetOf(ex.task);
      if (ex.task && set) {
        if (!this.task.has(set)) this.task.set(set, emptyTable());
        addExample(this.task.get(set), ex.task, tokens);
      }
      if (ex.activity) addExample(this.activity, ex.activity, tokens);
      if (ex.matter) {
        if (!this.byMatter.has(ex.matter)) this.byMatter.set(ex.matter, { task: emptyTable(), activity: emptyTable() });
        const m = this.byMatter.get(ex.matter);
        if (ex.task) addExample(m.task, ex.task, tokens, SAME_MATTER_WEIGHT);
        if (ex.activity) addExample(m.activity, ex.activity, tokens, SAME_MATTER_WEIGHT);
      }
    }
  }

  stats() {
    const bySource = {};
    for (const ex of this.examples) bySource[ex.source ?? 'other'] = (bySource[ex.source ?? 'other'] ?? 0) + 1;
    return { examples: this.examples.length, bySource, codeSets: [...this.task.keys()] };
  }

  /**
   * Codes for a narrative. Uses the learned table when it's confident and has
   * enough history; otherwise the keyword rules.
   */
  suggest(narrative, codes, { codeSet, matter } = {}) {
    const rules = ruleCodes(narrative, codes);
    const tokens = tokenize(narrative);
    const pick = (field, table, matterTable, allowed) => {
      // Same-matter history first (it reflects how this client wants things coded), then everything.
      const local = matterTable && matterTable.n >= 6 ? classify(matterTable, tokens, allowed) : null;
      if (local && local.confidence >= 0.55) return { code: local.code, source: 'matter history' };
      const global = table && table.n >= 15 ? classify(table, tokens, allowed) : null;
      if (global && global.confidence >= 0.5) return { code: global.code, source: 'your history' };
      return { code: rules[field], source: 'rules' };
    };
    const m = matter ? this.byMatter.get(matter) : null;
    const task = pick('task_code', this.task.get(codeSet), m?.task, Object.keys(codes.tasks));
    const activity = pick('activity_code', this.activity, m?.activity, Object.keys(codes.activities));
    return { task_code: task.code, activity_code: activity.code, source: { task: task.source, activity: activity.source } };
  }
}

/** Examples from Intapp .TIM records (exported or imported): narrative + u5/u6 codes. */
export function examplesFromTim(records, source = 'import') {
  return records
    .filter((r) => r.na && (r.u5 || r.u6))
    .map((r) => ({
      at: Date.now(),
      source,
      ref: r.ref || undefined,
      matter: r.ma || undefined,
      code_set: codeSetOf(r.u5 || '') || undefined,
      narrative: r.na,
      task: r.u5 || undefined,
      activity: r.u6 || undefined,
    }));
}
