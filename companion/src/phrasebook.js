// The phrasebook: what the instant drafter can't know from rules alone, learned
// from you.
//
// - Custom entries you type in Settings ("officer cert = officer's certificate").
// - Learned corrections: at export, each narrative is compared with the instant
//   draft it started from; the words you changed become substitutions
//   ("officer certificate" -> "officer's certificate"). They're scored by how
//   often and how recently you made them (45-day half-life), per matter and
//   overall: one correction applies on that matter right away; the same change
//   on two different matters applies everywhere. A matter's vocabulary fades
//   after it goes quiet.
// - Frequent phrases from your past narratives feed Whisper's vocabulary hint.
// - Rules the teacher proposed and you accepted (teacher.js): shorthand, fixes
//   and verbs, applied here like everything else.
//
// Everything is plain counting over a small JSONL log; no AI model. (The
// teacher uses one offline to propose rules; drafting never does.)

import fs from 'node:fs';

const DAY = 86_400_000;
const HALF_LIFE_DAYS = 45;
const MATTER_THRESHOLD = 0.9; // about one recent correction on this matter
const GLOBAL_THRESHOLD = 1.8; // about two recent corrections anywhere

// ---------- diffing a draft against what you actually sent ----------

const key = (w) => w.toLowerCase().replace(/^[("'“]+|[)"'”.,;:]+$/g, '');
const tidy = (tokens) => tokens.join(' ').replace(/^[("'“]+|[)"'”.,;:]+$/g, '').trim();

/** Word-level longest-common-subsequence diff -> replaced spans [{ from, to }]. */
export function learnFromEdit(draft, final) {
  const a = String(draft ?? '').split(/\s+/).filter(Boolean);
  const b = String(final ?? '').split(/\s+/).filter(Boolean);
  if (!a.length || !b.length || a.length > 200 || b.length > 200) return [];
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(a[i]) === key(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (open) hunks.push({ ...open, ai2: i, bj2: j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && key(a[i]) === key(b[j])) {
      close();
      i++;
      j++;
    } else {
      open ??= { ai: i, bj: j };
      if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) j++;
      else i++;
    }
  }
  close();

  const subs = [];
  for (const h of hunks) {
    let [as, ae, bs, be] = [h.ai, h.ai2, h.bj, h.bj2];
    if (ae === as || be === bs) continue; // pure insertion or deletion: no phrase to map from
    if (ae - as > 4 || be - bs > 6) continue; // a rewrite, not a phrasing fix
    // A small edit to the same word ("officer" -> "officer's") needs a neighbor
    // for context, or it would fire everywhere. Swapping in a different word
    // ("deck" -> "board presentation") is a rule on its own.
    const sameWord = (x, y) => {
      const [p, q] = [key(x), key(y)];
      return p.length >= 3 && (q.startsWith(p.slice(0, Math.max(3, p.length - 2))) || p.startsWith(q.slice(0, Math.max(3, q.length - 2))));
    };
    if (ae - as === 1 && be - bs === 1 && sameWord(a[as], b[bs])) {
      if (ae < n && be < m && key(a[ae]) === key(b[be])) [ae, be] = [ae + 1, be + 1];
      else if (as > 0 && bs > 0 && key(a[as - 1]) === key(b[bs - 1])) [as, bs] = [as - 1, bs - 1];
      else continue;
    }
    const from = tidy(a.slice(as, ae));
    const to = tidy(b.slice(bs, be));
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue; // case-only edits aren't phrasing
    subs.push({ from, to });
  }
  return subs;
}

// ---------- custom entries ----------

/** "shorthand = expansion" lines -> { shorthand: expansion } (lowercase keys). */
export function parseCustom(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(.+?)\s*(?:=>|=|→)\s*(.+?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- the phrasebook ----------

export class Phrasebook {
  /**
   * file: JSONL log of corrections (null = in memory, for tests).
   * custom(): the user's "shorthand = expansion" text. corpus(): past examples
   * with narratives (the code memory's), for Whisper vocabulary.
   */
  constructor({ file = null, custom = () => '', corpus = () => [], taught = () => [], now = () => Date.now() } = {}) {
    this.file = file;
    this.custom = custom;
    this.corpus = corpus;
    this.taught = taught; // accepted teacher rules: [{ type: 'phrase' | 'fix' | 'verb', from, to, matter? }]
    this.now = now;
    this.corrections = [];
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.corrections.push(JSON.parse(line));
        } catch {
          // skip a damaged line
        }
      }
    }
    this.rebuild();
  }

  /**
   * Log what you changed between an instant draft and the narrative you sent.
   * Every edit is kept (the teacher learns from additions and rewrites too);
   * returns the substitutions the phrasebook itself learned from it.
   */
  addCorrection({ draft, final, notes = '', matter = null, at = this.now() }) {
    if (!String(draft ?? '').trim() || !String(final ?? '').trim()) return [];
    if (String(draft).trim().replace(/\s+/g, ' ') === String(final).trim().replace(/\s+/g, ' ')) return [];
    const subs = learnFromEdit(draft, final);
    const rec = { at, matter, notes, draft, final };
    this.corrections.push(rec);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    this.rebuild();
    return subs;
  }

  /**
   * Consolidation: re-derive learned substitutions with recency weighting.
   * Value-neutral: an edit that undoes a learned change (it wrote "Analyzed",
   * you put "Reviewed" back) first cancels that change's score instead of
   * teaching the opposite; only what's left over counts the other way.
   */
  rebuild() {
    const now = this.now();
    this.learned = new Map(); // from(lower) -> { from, global: Map(to -> score), matters: Map(matter -> Map(to -> score)), undone: Map(to -> n) }
    const entryFor = (from) => {
      const k = from.toLowerCase();
      if (!this.learned.has(k)) this.learned.set(k, { from, global: new Map(), matters: new Map(), undone: new Map(), seenOn: new Map() });
      return this.learned.get(k);
    };
    const findTo = (map, to) => [...map.keys()].find((k) => k.toLowerCase() === to.toLowerCase());
    for (const c of [...this.corrections].sort((a, b) => a.at - b.at)) {
      const weight = 0.5 ** ((now - c.at) / DAY / HALF_LIFE_DAYS);
      for (const { from, to } of learnFromEdit(c.draft, c.final)) {
        let left = weight;
        // Is this edit reversing a change learned earlier (to -> from)?
        const forward = this.learned.get(to.toLowerCase());
        const fwdTo = forward && findTo(forward.global, from);
        if (fwdTo && forward.global.get(fwdTo) > 0) {
          const cancel = Math.min(forward.global.get(fwdTo), left);
          forward.global.set(fwdTo, forward.global.get(fwdTo) - cancel);
          for (const [m, mm] of forward.matters) {
            // The matter it was undone on loses it outright; other matters lose what the global score lost.
            if (mm.has(fwdTo)) mm.set(fwdTo, Math.max(0, mm.get(fwdTo) - (m === c.matter ? weight : cancel)));
          }
          forward.undone.set(fwdTo, (forward.undone.get(fwdTo) ?? 0) + 1);
          left -= cancel;
        }
        if (left <= 1e-9) continue;
        const entry = entryFor(from);
        entry.global.set(to, (entry.global.get(to) ?? 0) + left);
        if (!entry.seenOn.has(to)) entry.seenOn.set(to, new Set());
        entry.seenOn.get(to).add(c.matter ?? '');
        if (c.matter) {
          if (!entry.matters.has(c.matter)) entry.matters.set(c.matter, new Map());
          const mm = entry.matters.get(c.matter);
          mm.set(to, (mm.get(to) ?? 0) + left);
        }
      }
    }
  }

  /** The replacement to use for a learned phrase on a matter, or null if not confident yet. */
  #choose(entry, matter) {
    const best = (map) => [...map.entries()].sort((x, y) => y[1] - x[1])[0];
    const local = matter && entry.matters.get(matter) ? best(entry.matters.get(matter)) : null;
    if (local && local[1] >= MATTER_THRESHOLD) return local[0];
    const global = best(entry.global);
    return global && this.#everywhere(entry, global[0], global[1]) ? global[0] : null;
  }

  /** Everywhere = strong enough overall, and seen on more than one matter (one matter's habit stays on that matter). */
  #everywhere(entry, to, score) {
    const seen = entry.seenOn.get(to) ?? new Set();
    return score >= GLOBAL_THRESHOLD && (seen.size >= 2 || seen.has(''));
  }

  /**
   * Options for the drafter on a matter: custom shorthand, learned fixes, and
   * accepted teacher rules. `extra` adds candidate rules (the teacher replays
   * your past edits with them before proposing anything).
   */
  options(matter, extra = [], { learned = true, taught: useTaught = true } = {}) {
    const rules = [];
    for (const entry of learned ? this.learned.values() : []) {
      const to = this.#choose(entry, matter);
      if (to) rules.push({ re: new RegExp(`(?<![\\w'])${escapeRe(entry.from)}(?![\\w'])`, 'gi'), to });
    }
    const taught = [...(useTaught ? this.taught() : []), ...extra].filter((r) => !r.matter || r.matter === matter);
    const phrases = parseCustom(this.custom());
    const verbs = {};
    for (const r of taught) {
      if (r.type === 'phrase') phrases[r.from.toLowerCase()] = r.to;
      else if (r.type === 'verb') verbs[r.from.toLowerCase()] = r.to;
      else if (r.type === 'fix') rules.push({ re: new RegExp(`(?<![\\w'])${escapeRe(r.from)}(?![\\w'])`, 'gi'), to: r.to });
    }
    rules.sort((x, y) => y.re.source.length - x.re.source.length); // longer phrases first
    const fix = (text) => {
      let out = text;
      for (const { re, to } of rules) {
        out = out.replace(re, (match, offset) => {
          // Keep sentence-initial capitalization.
          const atStart = offset === 0 || /[.;]\s*$/.test(out.slice(0, offset));
          return atStart && /^[A-Z]/.test(match) ? to.charAt(0).toUpperCase() + to.slice(1) : to;
        });
      }
      return out;
    };
    return { phrases, verbs, fix };
  }

  /** Learned substitutions for display: phrase, replacement, strength, and where it applies. */
  list(limit = 50) {
    const rows = [];
    for (const entry of this.learned.values()) {
      for (const [to, score] of entry.global) {
        const matters = [...entry.matters.entries()].filter(([, mm]) => (mm.get(to) ?? 0) >= MATTER_THRESHOLD).map(([m]) => m);
        rows.push({ from: entry.from, to, score: Math.round(score * 100) / 100, everywhere: this.#everywhere(entry, to, score), matters, undone: entry.undone.get(to) ?? 0 });
      }
    }
    return rows.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  /** Phrases worth giving Whisper as hints: your custom expansions, learned fixes, and common phrases from your narratives. */
  vocabulary(limit = 40) {
    const terms = new Map();
    const bump = (t, n) => terms.set(t, (terms.get(t) ?? 0) + n);
    for (const v of Object.values(parseCustom(this.custom()))) bump(v, 100);
    for (const row of this.list(100)) if (row.everywhere || row.matters.length) bump(row.to, 50); // not ones you've undone
    const counts = new Map();
    for (const ex of this.corpus()) {
      const w = String(ex.narrative ?? '').toLowerCase().replace(/[^a-z0-9'& -]+/g, ' ').split(/\s+/).filter(Boolean);
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= w.length; i++) {
          const gram = w.slice(i, i + n);
          if (gram.every((x) => x.length < 4)) continue; // need at least one substantive word
          if (/^(the|and|of|to|with|for|on|in|a|an|regarding)$/.test(gram[0]) || /^(the|and|of|to|with|for|on|in|a|an|regarding)$/.test(gram.at(-1))) continue;
          const g = gram.join(' ');
          counts.set(g, (counts.get(g) ?? 0) + 1);
        }
      }
    }
    for (const [g, c] of counts) if (c >= 3) bump(g, c);
    return [...terms.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([t]) => t);
  }

  stats() {
    const rows = this.list(1000);
    const active = rows.filter((r) => r.everywhere || r.matters.length);
    return { corrections: this.corrections.length, learned: rows.length, active: active.length, undone: rows.filter((r) => r.undone && !r.everywhere && !r.matters.length).length };
  }
}
