// Instant billing narratives from shorthand notes or dictation, with no AI model.
//
// Most of drafting is mechanical: expand shorthand ("officer cert" ->
// "officer's certificate"), put verbs in the past tense ("prepare" ->
// "Prepared"), and join the actions ("... and sent to client"). Rules do that
// in about a millisecond and never invent facts: the output only rewrites what
// you wrote or said. What rules can't know (your firm's phrasing, a matter's
// defined terms) comes from the phrasebook, which learns from your corrections
// (see phrasebook.js).

// ---------- shorthand ----------

/** Built-in legal shorthand (lowercase keys; longest match wins). Custom and learned entries override these. */
export const BASE_PHRASES = {
  'w/': 'with',
  'w/o': 'without',
  'w/r/t': 'with respect to',
  wrt: 'with respect to',
  re: 'regarding',
  about: 'regarding',
  agmt: 'agreement',
  agmts: 'agreements',
  cert: 'certificate',
  certs: 'certificates',
  'officer cert': "officer's certificate",
  'officers cert': "officer's certificate",
  "officer's cert": "officer's certificate",
  'secretary cert': "secretary's certificate",
  'sec cert': "secretary's certificate",
  "secretary's cert": "secretary's certificate",
  'bringdown cert': 'bring-down certificate',
  'closing cert': 'closing certificate',
  doc: 'document',
  docs: 'documents',
  tc: 'telephone conference',
  conf: 'conference',
  mtg: 'meeting',
  mtgs: 'meetings',
  opp: 'opposing',
  cp: 'counterparty',
  cps: 'counterparties',
  gc: 'general counsel',
  spa: 'stock purchase agreement',
  apa: 'asset purchase agreement',
  loi: 'letter of intent',
  dd: 'due diligence',
  sched: 'schedule',
  scheds: 'schedules',
  'discl scheds': 'disclosure schedules',
  'disc scheds': 'disclosure schedules',
  ltr: 'letter',
  ltrs: 'letters',
  'eng ltr': 'engagement letter',
  memo: 'memorandum',
  corr: 'correspondence',
  prelim: 'preliminary',
  'r&w': 'representations and warranties',
  'r&ws': 'representations and warranties',
  'reps and warranties': 'representations and warranties',
  'reps & warranties': 'representations and warranties',
  bod: 'board of directors',
  cmte: 'committee',
  mins: 'minutes',
  reso: 'resolution',
  resos: 'resolutions',
  'sig page': 'signature page',
  'sig pages': 'signature pages',
  'sig pgs': 'signature pages',
  ckl: 'checklist',
  tsa: 'transition services agreement',
  msa: 'master services agreement',
  ppm: 'private placement memorandum',
  sow: 'statement of work',
  atty: 'attorney',
  attys: 'attorneys',
  info: 'information',
  approx: 'approximately',
  govt: 'government',
  reg: 'regulatory',
  regs: 'regulations',
  rogs: 'interrogatories',
  rfp: 'requests for production',
  rfps: 'requests for production',
  rfa: 'requests for admission',
  mtd: 'motion to dismiss',
  msj: 'motion for summary judgment',
  depo: 'deposition',
  depos: 'depositions',
  priv: 'privilege',
  'priv log': 'privilege log',
  'm&c': 'meet and confer',
  'q&a': 'Q&A',
  nda: 'NDA',
  mac: 'MAC',
  mae: 'MAE',
  ip: 'IP',
  hsr: 'HSR',
  cfius: 'CFIUS',
  ceo: 'CEO',
  cfo: 'CFO',
};

// ---------- verbs ----------

/** Action verbs: base form -> past tense as written in a narrative. */
export const VERBS = {
  prepare: 'prepared',
  prep: 'prepared',
  send: 'sent',
  review: 'reviewed',
  rev: 'reviewed',
  draft: 'drafted',
  revise: 'revised',
  finalize: 'finalized',
  circulate: 'circulated',
  coordinate: 'coordinated',
  negotiate: 'negotiated',
  analyze: 'analyzed',
  research: 'researched',
  update: 'updated',
  respond: 'responded',
  reply: 'replied',
  correspond: 'corresponded',
  confer: 'conferred',
  discuss: 'discussed',
  attend: 'attended',
  file: 'filed',
  compile: 'compiled',
  organize: 'organized',
  summarize: 'summarized',
  comment: 'commented',
  markup: 'marked up',
  edit: 'edited',
  email: 'emailed',
  'e-mail': 'emailed',
  meet: 'met',
  speak: 'spoke',
  write: 'wrote',
  read: 'read',
  check: 'checked',
  confirm: 'confirmed',
  arrange: 'arranged',
  schedule: 'scheduled',
  distribute: 'distributed',
  collect: 'collected',
  gather: 'gathered',
  assemble: 'assembled',
  obtain: 'obtained',
  deliver: 'delivered',
  execute: 'executed',
  advise: 'advised',
  consider: 'considered',
  evaluate: 'evaluated',
  assess: 'assessed',
  investigate: 'investigated',
  interview: 'interviewed',
  outline: 'outlined',
  plan: 'planned',
  track: 'tracked',
  monitor: 'monitored',
  incorporate: 'incorporated',
  address: 'addressed',
  resolve: 'resolved',
  identify: 'identified',
  calculate: 'calculated',
  verify: 'verified',
  proofread: 'proofread',
  begin: 'began',
  start: 'started',
  continue: 'continued',
  work: 'worked',
};

/** Verbs strong enough to start a new action mid-clause ("prepare officer cert send to client"). */
const SPLITTING_VERBS = new Set([
  'prepare', 'send', 'review', 'draft', 'revise', 'finalize', 'circulate', 'negotiate', 'analyze', 'research',
  'respond', 'reply', 'discuss', 'attend', 'file', 'email', 'e-mail', 'call', 'confer', 'meet', 'distribute', 'execute',
]);
/** A verb right after one of these is part of the phrase, not a new action ("for review", "the draft", "to send"). */
const NO_SPLIT_AFTER = new Set([
  'to', 'and', 'or', 'the', 'a', 'an', 'for', 'of', 'with', 'w/', 're', 'regarding', 'about', 'on', 'into', 'per', 'my',
  'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'will', 'should', 'would', 'can', 'could', 'next',
  'further', 'final', 'initial', 'first', 'second', 'revised', 'draft', 'prior', 'latest', 'new', 'same',
]);

/** Every form of a verb (base, -ing, -ed, past) that maps back to its base. */
function verbForms(base, past) {
  const stem = base.endsWith('e') ? base.slice(0, -1) : base;
  const doubled = /[^aeiou][aeiou][bdglmnprt]$/.test(base) && base.length <= 4 ? base + base.at(-1) : base;
  // No "-s" forms: in shorthand, "comments", "drafts" and "emails" are almost always nouns.
  return [base, `${stem}ing`, `${doubled}ing`, past, `${base}ed`, `${stem}ed`];
}

/** Map any form to the base verb. */
const VERB_FORMS = new Map();
for (const [base, past] of Object.entries(VERBS)) for (const form of verbForms(base, past)) VERB_FORMS.set(form, base);
for (const v of ['call', 'calling', 'called', 'tc', 'tc\'d', 'phone', 'phoned', 'telephone']) VERB_FORMS.set(v, 'call');
SPLITTING_VERBS.add('call');

/**
 * The verb tables for one draft: the built-in ones plus extra verbs taught to
 * this drafter ({ base: past }, from the teacher), which also start new actions.
 */
function verbTables(extra = {}) {
  const keys = Object.keys(extra);
  if (!keys.length) return { verbs: VERBS, forms: VERB_FORMS, splitting: SPLITTING_VERBS };
  const verbs = { ...VERBS, ...extra };
  const forms = new Map(VERB_FORMS);
  const splitting = new Set(SPLITTING_VERBS);
  for (const base of keys) {
    for (const form of verbForms(base, extra[base])) if (!forms.has(form)) forms.set(form, base);
    splitting.add(base);
  }
  return { verbs, forms, splitting };
}

// ---------- tokens ----------

/** Split into word tokens, keeping shorthand like "w/", "r&w", "officer's", "8-K". */
function words(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

const bare = (w) => w.toLowerCase().replace(/^[("'“]+|[)"'”,:]+$/g, '');

/** Replace shorthand phrases (longest match first). `phrases` maps lowercase keys to expansions. */
export function expandShorthand(tokens, phrases) {
  const keys = Object.keys(phrases);
  const maxLen = Math.max(1, ...keys.map((k) => k.split(' ').length));
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    let matched = false;
    for (let n = Math.min(maxLen, tokens.length - i); n >= 1; n--) {
      const key = tokens.slice(i, i + n).map(bare).join(' ');
      if (key in phrases) {
        const trail = tokens[i + n - 1].match(/[,:)]+$/)?.[0] ?? '';
        out.push(...words(phrases[key] + trail));
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) out.push(tokens[i++]);
  }
  return out;
}

// ---------- actions ----------

/** Break a clause into actions at strong verbs ("prepare X send Y" -> two actions; "X and send Y" too). */
export function splitActions(tokens, { forms = VERB_FORMS, splitting = SPLITTING_VERBS } = {}) {
  const actions = [[]];
  tokens.forEach((tok, i) => {
    const base = forms.get(bare(tok));
    const prev = i > 0 ? bare(tokens[i - 1]) : null;
    const joined = prev === 'and' || prev === 'then';
    // Mid-clause "-ing" words are usually nouns ("stark meeting", "the filing"); they only start an action after "and"/"then".
    const nounish = /ing$/.test(bare(tok)) && !joined;
    const startsNew = i > 0 && base && splitting.has(base) && !nounish && (joined || !NO_SPLIT_AFTER.has(prev)) && !forms.has(prev);
    if (startsNew) {
      const cur = actions.at(-1);
      // "X and send Y": the joiner belongs to the output, not the action.
      if (['and', 'then'].includes(bare(cur.at(-1) ?? ''))) cur.pop();
      if (cur.length) actions.push([]);
    }
    actions.at(-1).push(tok);
  });
  return actions.filter((a) => a.length);
}

/** One action -> narrative phrase, verb in the past tense. */
function phraseAction(tokens, { verbs = VERBS, forms = VERB_FORMS } = {}) {
  const [first, ...rest] = tokens;
  const base = forms.get(bare(first));
  let restTokens = rest;
  if (base === 'call') {
    // "call w/ client re X" / "tc w/ ..." -> "Telephone conference with client regarding X"
    if (bare(restTokens[0] ?? '') === 'conference') restTokens = restTokens.slice(1);
    if (bare(restTokens[0] ?? '') === 'with') restTokens = restTokens.slice(1);
    return ['telephone conference with', ...restTokens].join(' ').replace(/ with$/, '');
  }
  if (bare(first) === 'conference' && bare(rest[0] ?? '') === 'call') return ['conference call', ...rest.slice(1)].join(' ');
  if (bare(first) === 'meeting' || bare(first) === 'meetings') return tokens.join(' '); // "Meeting with ..." is the convention
  if (bare(first) === 'telephone' && bare(rest[0] ?? '') === 'conference') return ['telephone conference', ...rest.slice(1)].join(' ');
  if (base === 'email' && bare(restTokens[0] ?? '') === 'to') restTokens = restTokens.slice(1); // "email to client" -> "emailed client"
  if (base === 'markup' || (base === undefined && bare(first) === 'mark' && bare(rest[0] ?? '') === 'up')) {
    return ['marked up', ...(base ? rest : rest.slice(1))].join(' ');
  }
  if (base && base !== 'call') return [verbs[base], ...restTokens].join(' ');
  return tokens.join(' ');
}

function joinActions(phrases) {
  phrases = phrases.map((p) => p.replace(/[,;:]+$/, ''));
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lowercase a clause's first word unless it's an acronym or a proper-looking word we didn't generate. */
function lowerFirst(s) {
  const [w] = s.split(' ');
  return /^[A-Z0-9&]{2,}$/.test(w) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------- draft ----------

/**
 * Notes or dictation -> narrative. `phrases` adds or overrides shorthand
 * (custom, learned and taught), `verbs` adds verbs ({ base: past }), and `fix`
 * applies learned corrections to the result.
 */
export function draftNarrative(notes, { phrases = {}, verbs = {}, fix = (s) => s } = {}) {
  const shorthand = { ...BASE_PHRASES, ...phrases };
  const tables = verbTables(verbs);
  const clauses = String(notes ?? '')
    .split(/;|\n|(?<=[a-z0-9)])\.\s+/i)
    .map((c) => c.trim().replace(/[.;,\s]+$/, ''))
    .filter(Boolean);
  const out = clauses.map((clause, i) => {
    const tokens = expandShorthand(words(clause), shorthand);
    const text = joinActions(splitActions(tokens, tables).map((a) => phraseAction(a, tables))).replace(/\s+/g, ' ').trim();
    return i === 0 ? capitalize(text) : lowerFirst(text);
  });
  if (!out.length) return '';
  return fix(`${out.join('; ')}.`.replace(/\.\.$/, '.'));
}

/** Clauses of a note as separate narratives, for splitting a day into one entry per task. */
export function draftClauses(notes, opts) {
  return String(notes ?? '')
    .split(/;|\n/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => ({ notes: c, narrative: draftNarrative(c, opts) }));
}
