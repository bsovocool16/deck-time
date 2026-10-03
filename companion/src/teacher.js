// The teacher: a smart model, offline, writing dumb rules.
//
// Drafting is instant and deterministic (drafter.js + phrasebook.js). What the
// rules can't know, you show them every time you edit a draft before export:
// each edit is logged (corrections.jsonl). When you ask, the teacher hands
// those edits to the local model (Ollama) once and asks for rules the drafter
// can run on its own:
//
//   phrase  shorthand in your notes -> wording       ("spa" -> "stock purchase agreement")
//   fix     wording in a draft -> what you billed     ("regarding the same" -> "regarding same")
//   verb    a verb the drafter left alone -> past     ("redline" -> "redlined")
//
// Nothing the model says is trusted. Each proposed rule is replayed against
// your past edits by plain code: it's kept only if it brings drafts closer to
// what you actually billed and makes none of them worse, and only if every word
// it adds already appears in your own narratives (no invented facts). You then
// accept or reject each one. Accepted rules live in teacher.json and apply on
// the next draft; the model is never in the click path.
//
// Accepted rules keep earning their place. Every later edit where a rule
// changed the draft is a vote: you kept its wording, or you undid it.
// Accepting counts as one keep; once undos outnumber keeps, the rule turns
// itself off. No opinions of its own: it follows what you change, either way.

import fs from 'node:fs';
import { ollamaChat } from './ai.js';
import { VERBS, draftNarrative } from './drafter.js';

const MAX_EXAMPLES = 40; // edits shown to the model per run
const MAX_RULES = 12;
const word = (w) => w.toLowerCase().replace(/^[("'“]+|[)"'”.,;:]+$/g, '');
const wordsOf = (s) => String(s ?? '').split(/\s+/).map(word).filter(Boolean);

/** Word-level edit distance (punctuation and case ignored). */
export function wordDistance(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/**
 * What the drafter would produce for a past edit from its rules: built-in,
 * your shorthand and accepted teacher rules, plus optional candidates. The
 * phrasebook's own narrow learned fixes are left out, so a general rule
 * ("redline" is a verb) gets credit for the edits those fixes patch one at a time.
 */
function redraft(phrasebook, c, extra = []) {
  const opts = phrasebook.options(c.matter, extra, { learned: false });
  return c.notes?.trim() ? draftNarrative(c.notes, opts) : opts.fix(c.draft);
}

/**
 * Replay a candidate rule over past edits. A rule earns its place by moving
 * drafts toward what you billed (improved) without moving any away (worsened).
 */
export function replay(phrasebook, corrections, rule) {
  const result = { improved: 0, worsened: 0, matters: new Set(), examples: [] };
  for (const c of corrections) {
    if (rule.matter && c.matter !== rule.matter) continue;
    const before = redraft(phrasebook, c);
    const after = redraft(phrasebook, c, [rule]);
    if (before === after) continue;
    const delta = wordDistance(after, c.final) - wordDistance(before, c.final);
    if (delta < 0) {
      result.improved++;
      result.matters.add(c.matter);
      if (result.examples.length < 2) result.examples.push({ before, after, final: c.final });
    } else if (delta > 0) result.worsened++;
  }
  return { ...result, matters: [...result.matters] };
}

/** Plain checks on a model's rule before it's even replayed. Returns a reason it's rejected, or null. */
export function checkRule(rule, { finals, known = [] }) {
  if (!['phrase', 'fix', 'verb'].includes(rule.type)) return 'unknown type';
  const from = String(rule.from ?? '').trim();
  const to = String(rule.to ?? '').trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return 'empty or unchanged';
  if (from.length > 40 || to.length > 80) return 'too long to be a rule';
  if (rule.type === 'verb') {
    if (!/^[a-z][a-z-]*$/.test(from) || from.includes(' ')) return 'a verb is one word';
    if (from in VERBS) return 'already a known verb';
  }
  // Every word it writes must already be in something you billed: no invented facts.
  const vocab = new Set(finals.flatMap(wordsOf));
  const missing = wordsOf(to).filter((w) => !vocab.has(w));
  if (missing.length) return `adds words you never used (${missing.join(', ')})`;
  const id = ruleKey(rule);
  if (known.includes(id)) return 'already accepted or rejected';
  return null;
}

const ruleKey = (r) => [r.type, String(r.from).toLowerCase().trim(), String(r.to).trim(), r.matter ?? ''].join('\u0000');

const SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['phrase', 'fix', 'verb'] },
          from: { type: 'string' },
          to: { type: 'string' },
          scope: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['type', 'from', 'to', 'scope', 'reason'],
      },
    },
  },
  required: ['rules'],
};

export function teacherPrompt(examples, { accepted = [] } = {}) {
  const system = [
    "You improve a deterministic drafter of lawyers' billing narratives. It turns shorthand notes into a narrative with fixed rules (shorthand expansion, past tense, joining actions). It cannot think; it can only follow rules you write.",
    'Each example shows NOTES (typed or dictated), DRAFT (what the rules produced) and FINAL (what the lawyer actually billed). Write rules that would make future drafts closer to FINAL.',
    'Rule types:',
    '- phrase: shorthand as it appears in NOTES -> the wording FINAL uses for it. Applied before drafting. Shape: {"type":"phrase","from":"<shorthand>","to":"<wording>"}',
    '- fix: words as they appear in DRAFT -> the words FINAL uses instead. Applied to the finished draft. Shape: {"type":"fix","from":"<draft words>","to":"<final words>"}',
    '- verb: a verb the drafter left in the present tense -> the past tense FINAL uses. Shape: {"type":"verb","from":"<verb>","to":"<past tense>"}',
    'Learn only from what this lawyer changed. Do not apply your own style preferences; if the lawyer changes something both ways, leave it alone.',
    'scope: "everywhere" if the lawyer makes the same change on more than one matter; otherwise the matter id from the example.',
    'Use the shortest shorthand that carries the meaning ("cp", not "cp checklist"), so the rule fires on new notes too.',
    'Only use words that appear in FINAL. Never add names, facts, amounts or dates that a rule would insert into unrelated entries. Prefer short, general rules that would fire again; skip one-off rewrites.',
    `Return at most ${MAX_RULES} rules, each with a one-sentence reason.`,
  ].join('\n');
  const known = accepted.length ? `\n\nRules already in place (do not repeat):\n${accepted.map((r) => `${r.type}: ${r.from} -> ${r.to}`).join('\n')}` : '';
  const user =
    examples.map((c, i) => `Example ${i + 1} [matter ${c.matter || 'none'}]\nNOTES: ${c.notes || '(not recorded)'}\nDRAFT: ${c.draft}\nFINAL: ${c.final}`).join('\n\n') + known;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export class Teacher {
  /**
   * file: teacher.json (accepted rules, pending proposals, rejections); null = in memory.
   * phrasebook: the drafter's phrasebook (for replays and the edit log).
   */
  constructor({ file = null, phrasebook, getConfig, fetchImpl = fetch, now = () => Date.now() }) {
    this.file = file;
    this.phrasebook = phrasebook;
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.running = false;
    this.state = { rules: [], proposals: [], rejected: [], lastRun: null };
    if (file && fs.existsSync(file)) {
      try {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        // unreadable: start fresh rather than fail to start
      }
    }
  }

  #save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  /** Accepted rules still in use (not undone more than kept), for the phrasebook to apply. */
  rules() {
    const votes = this.#votes();
    return this.state.rules.filter((r) => votes.get(r.id)?.active !== false);
  }

  /**
   * For each accepted rule, the edits since you accepted it where it changed
   * the draft: did what you billed keep its wording (kept) or undo it (undone)?
   * Cached until there are new edits or rules.
   */
  #votes() {
    const key = `${this.phrasebook.corrections.length}|${this.state.rules.map((r) => r.id).join(',')}`;
    if (this.cache?.key === key) return this.cache.votes;
    const votes = new Map();
    for (const rule of this.state.rules) {
      const others = this.state.rules.filter((r) => r !== rule);
      let kept = 0;
      let undone = 0;
      for (const c of this.phrasebook.corrections) {
        if (!(c.at > (rule.accepted_at ?? 0)) || !c.notes?.trim() || (rule.matter && c.matter !== rule.matter)) continue;
        const draft = (rules) => draftNarrative(c.notes, this.phrasebook.options(c.matter, rules, { learned: false, taught: false }));
        const without = draft(others);
        const withRule = draft([...others, rule]);
        if (without === withRule) continue; // didn't fire on this entry
        const delta = wordDistance(withRule, c.final) - wordDistance(without, c.final);
        if (delta < 0) kept++;
        else if (delta > 0) undone++;
      }
      votes.set(rule.id, { kept, undone, active: undone <= kept + 1 }); // accepting counts as one keep
    }
    this.cache = { key, votes };
    return votes;
  }

  status() {
    const edits = this.phrasebook.corrections.length;
    return {
      running: this.running,
      edits,
      ready: edits >= 3,
      model: this.getConfig().ai?.model ?? '',
      lastRun: this.state.lastRun,
      proposals: this.state.proposals,
      rules: this.state.rules.map((r) => ({ ...r, ...(this.#votes().get(r.id) ?? { kept: 0, undone: 0, active: true }) })),
    };
  }

  /** Review your edits with the local model and keep the rules that pass the replay. */
  async run() {
    if (this.running) throw Object.assign(new Error('The teacher is already reviewing your edits'), { status: 409 });
    const all = this.phrasebook.corrections.filter((c) => c.final && (c.notes || c.draft)).slice(-200);
    if (all.length < 3) throw Object.assign(new Error('Export a few entries whose drafts you edited first; the teacher learns from those edits'), { status: 400 });
    // Show the model only edits the drafter still gets wrong today.
    const open = all.filter((c) => wordDistance(redraft(this.phrasebook, c), c.final) > 0).slice(-MAX_EXAMPLES);
    const started = this.now();
    if (!open.length) {
      this.state.lastRun = { at: started, reviewed: all.length, suggested: 0, kept: 0, note: 'Your drafts already match what you billed' };
      this.#save();
      return this.status();
    }
    this.running = true;
    try {
      const config = this.getConfig();
      const raw = await ollamaChat({
        config,
        messages: teacherPrompt(open, { accepted: this.state.rules }),
        format: SCHEMA,
        temperature: 0,
        timeoutMs: 300_000, // a one-off review; it can take a minute or two
        fetchImpl: this.fetchImpl,
      });
      let suggested = [];
      try {
        suggested = (JSON.parse(raw).rules ?? []).slice(0, MAX_RULES);
      } catch {
        throw Object.assign(new Error('The model returned something that was not a list of rules; try again'), { status: 502 });
      }
      const finals = all.map((c) => c.final);
      const known = [...this.state.rules, ...this.state.rejected].map(ruleKey);
      const kept = [];
      const dropped = [];
      for (const s of suggested) {
        const rule = {
          type: s.type,
          from: String(s.from ?? '').trim(),
          to: String(s.to ?? '').trim(),
          matter: s.scope && !/^everywhere$/i.test(String(s.scope).trim()) ? String(s.scope).replace(/^\s*matter\s*/i, '').trim() || undefined : undefined,
        };
        if (rule.type === 'verb') rule.from = rule.from.toLowerCase();
        const problem = checkRule(rule, { finals, known: [...known, ...kept.map(ruleKey)] });
        if (problem) {
          dropped.push({ ...rule, why: problem });
          continue;
        }
        const evidence = replay(this.phrasebook, all, rule);
        // A rule is a pattern: it must fix at least two past drafts and make none worse.
        if (evidence.worsened > 0 || evidence.improved < 2) {
          dropped.push({ ...rule, why: evidence.worsened ? `makes ${evidence.worsened} past draft(s) worse` : evidence.improved ? 'only one past draft supports it' : 'would not have changed your past drafts' });
          continue;
        }
        // Seen on one matter only: keep it to that matter.
        if (!rule.matter && evidence.matters.length === 1 && evidence.matters[0]) rule.matter = evidence.matters[0];
        kept.push({ ...rule, id: `${started.toString(36)}-${kept.length}`, reason: String(s.reason ?? '').slice(0, 240), evidence, proposed_at: started });
      }
      kept.sort((a, b) => b.evidence.improved - a.evidence.improved);
      this.state.proposals = kept;
      this.state.lastRun = { at: started, ms: this.now() - started, reviewed: all.length, shown: open.length, suggested: suggested.length, kept: kept.length, dropped };
      this.#save();
      return this.status();
    } finally {
      this.running = false;
    }
  }

  /** Accept or reject a proposal. Accepted rules apply to the next draft. */
  decide(id, action) {
    const i = this.state.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw Object.assign(new Error('Proposal not found'), { status: 404 });
    const [p] = this.state.proposals.splice(i, 1);
    const rule = { id: p.id, type: p.type, from: p.from, to: p.to, ...(p.matter ? { matter: p.matter } : {}), reason: p.reason, accepted_at: this.now() };
    if (action === 'accept') this.state.rules.push(rule);
    else if (action === 'reject') this.state.rejected.push({ type: p.type, from: p.from, to: p.to, matter: p.matter });
    else {
      this.state.proposals.splice(i, 0, p);
      throw Object.assign(new Error("action must be 'accept' or 'reject'"), { status: 400 });
    }
    this.#save();
    return this.status();
  }

  /** Remove an accepted rule (it won't be proposed again). */
  remove(id) {
    const i = this.state.rules.findIndex((r) => r.id === id);
    if (i < 0) throw Object.assign(new Error('Rule not found'), { status: 404 });
    const [r] = this.state.rules.splice(i, 1);
    this.state.rejected.push({ type: r.type, from: r.from, to: r.to, matter: r.matter });
    this.#save();
    return this.status();
  }
}
