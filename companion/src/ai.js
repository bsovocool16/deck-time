// Narrative drafting via a local Ollama model. Nothing leaves this machine.

export function buildPrompt({ matter, notes, hours, styleGuide, examples }) {
  const system = [
    'You write billing narratives for a lawyer\'s time entries.',
    'Rewrite the lawyer\'s shorthand notes as one polished narrative.',
    'Rules:',
    styleGuide,
    'Use only facts present in the notes. If the notes are vague, stay vague rather than guessing.',
    'Expand common abbreviations (e.g., "w/" = with, "re" = regarding, "opp" = opposing, "ltr" = letter, "tc" = telephone conference, "conf" = conference, "rev" = review, "agmt" = agreement).',
    'Reply with the narrative text only: no quotes, labels, or explanation.',
  ].join('\n');

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

export async function draftNarrative({ config, matter, notes, hours, recent = [], fetchImpl = fetch }) {
  if (!notes?.trim()) throw Object.assign(new Error('Add a few words of notes first'), { status: 400 });
  const { styleGuide, examples } = config.ai;
  // Past narratives for this matter keep terminology consistent.
  const allExamples = [...examples, ...recent.filter((r) => r.notes)].slice(-6);
  const messages = buildPrompt({ matter, notes, hours, styleGuide, examples: allExamples });

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
