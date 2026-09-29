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
  const { baseUrl, model, styleGuide, examples } = config.ai;
  // Past narratives for this matter keep terminology consistent.
  const allExamples = [...examples, ...recent.filter((r) => r.notes)].slice(-6);
  const messages = buildPrompt({ matter, notes, hours, styleGuide, examples: allExamples });

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.2 } }),
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
  return cleanNarrative(data.message?.content ?? '');
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
