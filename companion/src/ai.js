// Narrative drafting via a local Ollama model. Nothing leaves this machine.

export function buildPrompt({ matter, notes, hours, styleGuide, examples, rules }) {
  const system = [
    'You write billing narratives for a lawyer\'s time entries.',
    'Rewrite the lawyer\'s shorthand notes as one polished narrative.',
    'Rules:',
    styleGuide,
    'Use only facts present in the notes. If the notes are vague, stay vague rather than guessing.',
    'Expand common abbreviations (e.g., "w/" = with, "re" = regarding, "opp" = opposing, "ltr" = letter, "tc" = telephone conference, "conf" = conference, "rev" = review, "agmt" = agreement).',
    rules?.guidelines ? `This client's billing guidelines (follow them):\n${rules.guidelines}` : null,
    rules?.no_block_billing
      ? 'This client prohibits block billing: describe a single task. Do not join separate tasks with semicolons or "and".'
      : null,
    'Reply with the narrative text only: no quotes, labels, or explanation.',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const ex of examples) {
    messages.push({ role: 'user', content: userTurn({ matterName: 'Example matter', notes: ex.notes }) });
    messages.push({ role: 'assistant', content: ex.narrative });
  }
  messages.push({ role: 'user', content: userTurn({ matterName: matter.name, notes, hours }) });
  return messages;
}

function userTurn({ matterName, notes, hours }) {
  return [`Matter: ${matterName}`, hours ? `Time: ${hours} hours` : null, `Notes: ${notes}`].filter(Boolean).join('\n');
}

export function cleanNarrative(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning models
    .trim()
    .replace(/^["'“]|["'”]$/g, '')
    .replace(/^(narrative:\s*)/i, '')
    .replace(/^["'“]|["'”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function draftNarrative({ config, matter, notes, hours, recent = [], rules, fetchImpl = fetch }) {
  if (!notes?.trim()) throw Object.assign(new Error('Add a few words of notes first'), { status: 400 });
  const { styleGuide, examples } = config.ai;
  // Past narratives for this matter keep terminology consistent.
  const allExamples = [...examples, ...recent.filter((r) => r.notes)].slice(-6);
  const messages = buildPrompt({ matter, notes, hours, styleGuide, examples: allExamples, rules });

  return cleanNarrative(await ollamaChat({ config, messages, fetchImpl }));
}

async function ollamaChat({ config, messages, format, fetchImpl }) {
  const { baseUrl, model } = config.ai;
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, format, options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach Ollama at ${baseUrl}. Is it running? (${e.message})`), { status: 503 });
  }
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 404 ? ` Try: ollama pull ${model}` : '';
    throw Object.assign(new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}${hint}`), { status: 502 });
  }
  const data = await res.json();
  return data.message?.content ?? '';
}

export async function aiStatus(config, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${config.ai.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    return { reachable: true, model: config.ai.model, installed: names.includes(config.ai.model) || names.includes(`${config.ai.model}:latest`), models: names };
  } catch {
    return { reachable: false, model: config.ai.model, installed: false, models: [] };
  }
}

const CODE_GUIDANCE = [
  'The task code describes the substance of the work; the activity code describes how it was done.',
  '"Third party" means anyone other than the client and the firm: the client is never a third party.',
  'Any lawyer outside the firm (opposing counsel, co-counsel, counsel to another party) is "other outside counsel".',
  'Reviewing or analyzing documents to advise the client is analysis and advice, not fact gathering; so is reporting that analysis to the client or deal team.',
].join('\n');

/**
 * Pick a UTBMS task + activity code for a narrative. Ollama's structured output
 * (JSON schema with enums) guarantees the answer is one of the allowed codes.
 */
export async function suggestCodes({ config, narrative, codes, fetchImpl = fetch }) {
  if (!narrative?.trim()) throw Object.assign(new Error('Draft or write a narrative first'), { status: 400 });
  const list = (obj) => Object.entries(obj).map(([code, label]) => `${code}: ${label}`).join('\n');
  const messages = [
    {
      role: 'system',
      content: [
        'You assign UTBMS billing codes to a lawyer\'s time entry.',
        'Choose the single best task code and the single best activity code for the work described.',
        'If the entry mixes tasks, choose the code for the predominant work.',
        CODE_GUIDANCE,
        `Task codes:\n${list(codes.tasks)}`,
        `Activity codes:\n${list(codes.activities)}`,
      ].join('\n\n'),
    },
    { role: 'user', content: `Time entry: ${narrative}` },
  ];
  const format = {
    type: 'object',
    properties: {
      task_code: { type: 'string', enum: Object.keys(codes.tasks) },
      activity_code: { type: 'string', enum: Object.keys(codes.activities) },
    },
    required: ['task_code', 'activity_code'],
  };
  const res = await ollamaChat({ config, messages, format, fetchImpl });
  let out;
  try {
    out = JSON.parse(res);
  } catch {
    throw Object.assign(new Error('Model returned invalid JSON for codes'), { status: 502 });
  }
  // Belt and braces in case a model ignores the schema.
  if (!(out.task_code in codes.tasks) || !(out.activity_code in codes.activities)) {
    throw Object.assign(new Error(`Model suggested unknown codes: ${out.task_code}/${out.activity_code}`), { status: 502 });
  }
  return { task_code: out.task_code, activity_code: out.activity_code };
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * Propose splitting a day's work on a matter into separate entries (for clients
 * that prohibit block billing). Uses the timeline — timer segments and
 * timestamped notes — to apportion hours. Returns [{notes, narrative, hours,
 * task_code?, activity_code?}] whose hours sum to totalHours.
 */
export async function proposeSplit({ config, matter, rules, notes, timeline, totalHours, codes, increment = 0.1, fetchImpl = fetch }) {
  if (!notes?.trim() && !timeline.notes.length) throw Object.assign(new Error('Add notes or dictation describing the work first'), { status: 400 });
  const lines = [
    ...timeline.segments.map((s) => ({ ts: s.start_ms, text: `[timer ${hhmm(s.start_ms)}–${s.end_ms ? hhmm(s.end_ms) : 'now'}]` })),
    ...timeline.notes.map((n) => ({ ts: n.ts, text: `${hhmm(n.ts)} ${n.source === 'dictated' ? '(dictated) ' : ''}${n.text}` })),
  ].sort((a, b) => a.ts - b.ts);

  const system = [
    'You split a lawyer\'s day of work on one matter into separate billing entries, one task per entry.',
    'The client prohibits block billing, so each distinct task (e.g., legal analysis; drafting an email or memo about it; each call or meeting) gets its own entry.',
    rules.guidelines ? `Client billing guidelines (follow them exactly):\n${rules.guidelines}` : null,
    `Allocate exactly ${totalHours} hours in total, in multiples of ${increment}, at least ${increment} per entry.`,
    'Use the timestamps to apportion time: a note usually marks when that task began. Calls and emails are usually shorter than analysis.',
    'For each entry give "notes": the part of the lawyer\'s shorthand notes it covers (copy their words, not the timeline), and "narrative": a polished past-tense narrative following this style guide:',
    config.ai.styleGuide,
    'Use only facts in the notes. Order entries chronologically.',
    codes ? `Also choose the best UTBMS task and activity code for each entry.\n${CODE_GUIDANCE}` : null,
    codes ? `Task codes:\n${Object.entries(codes.tasks).map(([c, l]) => `${c}: ${l}`).join('\n')}` : null,
    codes ? `Activity codes:\n${Object.entries(codes.activities).map(([c, l]) => `${c}: ${l}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const user = [`Matter: ${matter.name}`, `Total time: ${totalHours} hours`, `Notes: ${notes || '(see timeline)'}`, lines.length ? `Timeline:\n${lines.map((l) => l.text).join('\n')}` : null]
    .filter(Boolean)
    .join('\n');

  const item = {
    type: 'object',
    properties: {
      notes: { type: 'string' },
      narrative: { type: 'string' },
      hours: { type: 'number' },
      ...(codes
        ? { task_code: { type: 'string', enum: Object.keys(codes.tasks) }, activity_code: { type: 'string', enum: Object.keys(codes.activities) } }
        : {}),
    },
    required: ['notes', 'narrative', 'hours', ...(codes ? ['task_code', 'activity_code'] : [])],
  };
  const format = { type: 'object', properties: { entries: { type: 'array', items: item, minItems: 1 } }, required: ['entries'] };

  const raw = await ollamaChat({ config, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], format, fetchImpl });
  let entries;
  try {
    ({ entries } = JSON.parse(raw));
  } catch {
    throw Object.assign(new Error('Model returned an invalid split'), { status: 502 });
  }
  if (!Array.isArray(entries) || !entries.length) throw Object.assign(new Error('Model returned no entries'), { status: 502 });
  return normalizeSplit(
    entries.map((e) => ({ ...e, narrative: cleanNarrative(e.narrative ?? ''), notes: String(e.notes ?? '').trim() })),
    totalHours,
    increment,
  );
}

/** Snap hours to the increment (min one increment each) and make them sum to the total. */
export function normalizeSplit(entries, totalHours, increment = 0.1) {
  const steps = (h) => Math.max(1, Math.round(Number(h) / increment) || 1);
  const target = Math.round(totalHours / increment);
  const out = entries.slice(0, Math.max(1, target)).map((e, i) => ({ ...e, steps: steps(e.hours), i }));
  let diff = target - out.reduce((s, e) => s + e.steps, 0);
  // Add to / take from the largest entries first, never below one increment.
  // Ties: add to earlier entries, take from later ones.
  while (diff !== 0) {
    const sorted = [...out].sort((a, b) => b.steps - a.steps || (diff > 0 ? a.i - b.i : b.i - a.i));
    const pickOne = diff > 0 ? sorted[0] : sorted.find((e) => e.steps > 1);
    if (!pickOne) break;
    pickOne.steps += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  return out.map(({ steps: n, i: _i, ...e }) => ({ ...e, hours: Math.round(n * increment * 100) / 100 }));
}
