// In-browser stand-in for the deck-time companion server, used by the hosted
// demo. It answers the same /api routes the real app calls, keeps everything in
// memory, and simulates the AI and dictation. Shared logic (rounding, .TIM
// export, codes, split allocation) is inlined from the real source by
// scripts/build-demo.js as T (time), C (codes), X (export), A (normalizeSplit),
// and B (looksBlockBilled).

(() => {
  const MIN = 60_000;
  const round2 = (n) => Math.round(n * 100) / 100;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (status, message) => Object.assign(new Error(message), { status });

  const config = {
    port: 7331,
    timekeeper: { id: '10001', name: 'Demo Attorney' },
    rounding: { increment: 0.1, mode: 'up', minimum: 0.1 },
    overnight: { workdayEnds: 0, check: true, checkHour: 5 },
    dailyTarget: 8,
    aiUse: { enabled: false, default: 'no', timField: '' },
    ai: {
      provider: 'demo',
      baseUrl: 'on this Mac (simulated here)',
      model: 'simulated',
      styleGuide: [
        'Write in the past tense, starting each task with a verb (e.g., "Reviewed", "Drafted", "Conferred").',
        'Separate distinct tasks with semicolons.',
        'Be specific about the document or subject, but never invent facts not in the notes.',
        'Do not use the words "work on", "attention to", or "various".',
        'Do not include hours or timekeeper names.',
      ].join('\n'),
      examples: [],
    },
    codes: { activities: C.ACTIVITY_CODES, taskSets: C.TASK_SETS },
    tim: {
      defaults: {
        billed: 'N', billing: 'N', closed: 'N', co: 'N', createdintimesaver: 'N', del: 'N', ex: 'N', f: 'TIME',
        originapplication: 'DTE Axiom', re: 'N', releasable: 'Y', st: 'Ready to be released', u1: '007', unconver: 'N', version: '9.14.43.829',
      },
      ssPrefix: '888888',
    },
  };

  // ---------- data ----------

  let db;
  let seq;
  const listeners = new Set(); // demo UI hooks: (event, detail) => void
  const emit = (event, detail) => listeners.forEach((fn) => fn(event, detail));

  function blank() {
    seq = 1;
    db = { matters: [], clients: new Map(), segments: [], entries: new Map(), notes: [], deck: null, dictation: { status: 'idle', error: null, started_at: null } };
  }

  const getMatter = (id) => db.matters.find((m) => m.id === +id) ?? null;
  const listMatters = (all = false) =>
    db.matters.filter((m) => all || !m.archived).sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name));

  function createMatter(input) {
    if (!input?.name?.trim()) throw err(400, 'Matter name is required');
    const m = {
      id: seq++, client_no: '', matter_no: '', label: '', color: '#2f5d8a', task_code: '', activity_code: '', code_set: '',
      block_billing: '', guidelines: '', archived: 0, ...input, name: input.name.trim(),
    };
    if (!m.label) m.label = m.name.slice(0, 14);
    db.matters.push(m);
    changed();
    return m;
  }

  function updateMatter(id, input) {
    const m = getMatter(id);
    if (!m) throw err(404, 'Matter not found');
    Object.assign(m, input);
    if (input.archived) {
      stopIfRunning(m.id);
      if (db.deck) db.deck = db.deck.map((s) => (s.matter_id === m.id ? { slot: s.slot, kind: 'empty', matter_id: null } : s));
    }
    changed();
    return m;
  }

  // ---------- key layout (same rules as the real store) ----------

  function deck() {
    if (db.deck) return db.deck.map((s) => ({ ...s }));
    const matters = listMatters().filter((m) => m.script !== 'admin').sort((a, b) => a.id - b.id);
    const fns = ['dictate', 'next-task', 'stop'];
    return Array.from({ length: 8 }, (_, slot) =>
      slot >= 5 ? { slot, kind: fns[slot - 5], matter_id: null } : matters[slot] ? { slot, kind: 'matter', matter_id: matters[slot].id } : { slot, kind: 'empty', matter_id: null },
    );
  }

  function setDeckSlot(slot, { kind, matter_id }) {
    const slots = deck();
    if (!(slot >= 0 && slot < slots.length)) throw err(400, 'No such key');
    if (!['matter', 'dictate', 'next-task', 'stop', 'review', 'empty'].includes(kind)) throw err(400, 'Unknown key type');
    if (kind === 'matter') {
      const m = getMatter(matter_id);
      if (!m || m.archived) throw err(400, 'Choose an active matter');
      for (const s of slots) if (s.kind === 'matter' && s.matter_id === m.id) Object.assign(s, { kind: 'empty', matter_id: null });
    }
    slots[slot] = { slot, kind, matter_id: kind === 'matter' ? +matter_id : null };
    db.deck = slots;
    emit('deck-changed');
    changed();
    return deck();
  }

  function swapDeckSlots(a, b) {
    const slots = deck();
    if (![a, b].every((x) => x >= 0 && x < slots.length)) throw err(400, 'No such key');
    [slots[a], slots[b]] = [{ ...slots[b], slot: a }, { ...slots[a], slot: b }];
    db.deck = slots;
    emit('deck-changed');
    changed();
    return deck();
  }

  const getClient = (no) => db.clients.get(no) ?? { client_no: no, name: '', no_block_billing: 0, guidelines: '' };

  function listClients() {
    const nos = [...new Set([...db.matters.filter((m) => m.client_no).map((m) => m.client_no), ...db.clients.keys()])].sort();
    return nos.map((no) => ({ ...getClient(no), matters: db.matters.filter((m) => m.client_no === no && !m.archived).map(({ id, name }) => ({ id, name })) }));
  }

  function updateClient(no, input) {
    const next = { ...getClient(no), ...input };
    next.no_block_billing = next.no_block_billing ? 1 : 0;
    db.clients.set(no, next);
    changed();
    return next;
  }

  function rulesFor(matter) {
    const client = matter.client_no ? getClient(matter.client_no) : null;
    const noBlock = matter.block_billing ? matter.block_billing === 'prohibited' : !!client?.no_block_billing;
    const guidelines = [client?.guidelines, matter.guidelines].map((g) => g?.trim()).filter(Boolean).join('\n');
    return { no_block_billing: noBlock, source: matter.block_billing ? 'matter' : client?.no_block_billing ? 'client' : null, guidelines };
  }

  // ---------- timers ----------

  const running = () => db.segments.filter((s) => s.end_ms == null).sort((a, b) => b.start_ms - a.start_ms)[0] ?? null;

  function currentTask(matterId, at) {
    const [start] = T.dayBounds(T.localDate(at));
    const tasks = db.segments.filter((s) => s.matter_id === matterId && s.start_ms >= start).map((s) => s.task);
    return tasks.length ? Math.max(...tasks) : 0;
  }

  // Same rule as the real store: back within 15 minutes continues the task.
  function resumeTask(matterId, at) {
    const [start] = T.dayBounds(T.localDate(at));
    const last = db.segments.filter((s) => s.matter_id === matterId && s.start_ms >= start && s.end_ms != null).sort((a, b) => b.end_ms - a.end_ms)[0];
    if (!last) return currentTask(matterId, at);
    return at - last.end_ms <= 15 * MIN ? last.task : currentTask(matterId, at) + 1;
  }

  function toggle(matterId) {
    const matter = getMatter(matterId);
    if (!matter) throw err(404, 'Matter not found');
    const current = running();
    const now = Date.now();
    if (current) current.end_ms = now;
    if (!current || current.matter_id !== matter.id) {
      db.segments.push({ id: seq++, matter_id: matter.id, start_ms: now, end_ms: null, task: resumeTask(matter.id, now) });
      emit('started', matter);
    } else emit('stopped', matter);
    changed();
    return running();
  }

  function stop() {
    const current = running();
    if (current) {
      current.end_ms = Date.now();
      emit('stopped', getMatter(current.matter_id));
      changed();
    }
    return null;
  }

  function stopIfRunning(id) {
    if (running()?.matter_id === id) stop();
  }

  function nextTask(label) {
    const current = running();
    if (!current) throw err(400, 'Start a timer first');
    const now = Date.now();
    const task = currentTask(current.matter_id, now) + 1;
    current.end_ms = now;
    db.segments.push({ id: seq++, matter_id: current.matter_id, start_ms: now, end_ms: null, task });
    if (label?.trim()) addNote(label, current.matter_id);
    emit('next-task', task);
    changed();
    return running();
  }

  function addNote(text, matterId, source = 'typed', ts = Date.now()) {
    const id = matterId ?? running()?.matter_id;
    if (!id) throw err(400, 'Start a timer first');
    const clean = String(text).trim();
    if (!clean) throw err(400, 'Note is empty');
    const date = T.localDate(ts);
    db.notes.push({ id: seq++, date, matter_id: id, ts, text: clean, source });
    const e = getEntry(date, id);
    return updateEntry(date, id, { notes: e.notes ? `${e.notes}; ${clean}` : clean });
  }

  function segmentsForDay(date) {
    const [start, end] = T.dayBounds(date);
    const now = Date.now();
    return db.segments.filter((s) => s.start_ms < end && (s.end_ms ?? now) > start).sort((a, b) => a.start_ms - b.start_ms);
  }

  function timeline(date, matterId) {
    return {
      segments: segmentsForDay(date).filter((s) => s.matter_id === matterId),
      notes: db.notes.filter((n) => n.date === date && n.matter_id === matterId).sort((a, b) => a.ts - b.ts),
    };
  }

  function taskBlocks(date, matterId) {
    const [dayStart, dayEnd] = T.dayBounds(date);
    const now = Date.now();
    const blocks = new Map();
    for (const s of timeline(date, matterId).segments) {
      const start = Math.max(s.start_ms, dayStart);
      const end = Math.min(s.end_ms ?? now, dayEnd);
      const b = blocks.get(s.task) ?? { task: s.task, ms: 0, start, end, segments: [], notes: [] };
      b.ms += Math.max(end - start, 0);
      b.start = Math.min(b.start, start);
      b.end = Math.max(b.end, end);
      b.segments.push(s);
      blocks.set(s.task, b);
    }
    const list = [...blocks.values()].sort((a, b) => a.task - b.task);
    for (const n of timeline(date, matterId).notes) {
      let owner = null;
      let ownerStart = -Infinity;
      for (const b of list) {
        for (const s of b.segments) {
          const inside = n.ts >= s.start_ms && (s.end_ms == null ? n.ts <= now : n.ts < s.end_ms);
          if (inside && s.start_ms >= ownerStart) [owner, ownerStart] = [b, s.start_ms];
        }
      }
      owner ??= [...list].reverse().find((b) => b.start <= n.ts) ?? list[0];
      owner?.notes.push(n);
    }
    return list.map(({ segments, ...b }) => b);
  }

  // ---------- entries ----------

  const key = (date, m, part) => `${date}|${m}|${part}`;

  const getEntry = (date, matterId, part = 0) =>
    db.entries.get(key(date, matterId, part)) ?? {
      date, matter_id: +matterId, part, notes: '', narrative: '', hours_override: null, task_code: '', activity_code: '', status: 'draft', exported_at: null,
    };

  const partsOf = (date, matterId) =>
    [...db.entries.values()].filter((e) => e.date === date && e.matter_id === +matterId).sort((a, b) => a.part - b.part);

  function write(date, matterId, part, e) {
    db.entries.set(key(date, matterId, part), { ...getEntry(date, matterId, part), ...e, date, matter_id: +matterId, part });
  }

  const ENTRY_FIELDS = ['notes', 'narrative', 'hours_override', 'task_code', 'activity_code', 'ai_used', 'status'];
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

  function updateEntry(date, matterId, input, part = 0) {
    if (!getMatter(matterId)) throw err(404, 'Matter not found');
    if (part > 0 && !db.entries.has(key(date, matterId, part))) throw err(404, 'Entry not found');
    const patch = pick(input, ENTRY_FIELDS);
    if (part > 0 && 'hours_override' in patch && !(patch.hours_override > 0)) throw err(400, 'Split entries need hours');
    if (patch.status === 'exported') patch.exported_at = Date.now();
    write(date, matterId, part, patch);
    changed();
    return getEntry(date, matterId, part);
  }

  function addPart(date, matterId, input = {}) {
    const hours = Number(input.hours_override ?? input.hours ?? 0.1);
    if (!(hours > 0)) throw err(400, 'Split entries need hours');
    if (!db.entries.has(key(date, matterId, 0))) write(date, matterId, 0, {});
    const next = Math.max(0, ...partsOf(date, matterId).map((p) => p.part)) + 1;
    write(date, matterId, next, { ...pick(input, ENTRY_FIELDS), hours_override: hours, status: 'draft' });
    changed();
    return getEntry(date, matterId, next);
  }

  function deletePart(date, matterId, part) {
    if (!(part > 0)) throw err(400, "The main entry can't be deleted; clear it instead");
    db.entries.delete(key(date, matterId, part));
    changed();
  }

  function applySplit(date, matterId, items) {
    if (!Array.isArray(items) || !items.length) throw err(400, 'Nothing to apply');
    if (items.slice(1).some((i) => !(Number(i.hours) > 0))) throw err(400, 'Every split entry needs hours');
    const timer = day(date).entries.find((e) => e.matter_id === +matterId && e.part === 0)?.computed_hours ?? 0;
    const splitTotal = round2(items.reduce((s, i) => s + (Number(i.hours) || 0), 0));
    const pinMain = Number(items[0].hours) > 0 && Math.abs(splitTotal - timer) > 0.001;
    for (const p of partsOf(date, matterId)) if (p.part > 0) db.entries.delete(key(date, matterId, p.part));
    const [first, ...rest] = items;
    const fields = ['notes', 'narrative', 'task_code', 'activity_code'];
    write(date, matterId, 0, { ...pick(first, fields), hours_override: pinMain ? round2(Number(first.hours)) : null, status: 'draft' });
    rest.forEach((item, i) => write(date, matterId, i + 1, { ...pick(item, fields), hours_override: round2(Number(item.hours)), status: 'draft' }));
    emit('split-applied');
    changed();
    return day(date).entries.filter((e) => e.matter_id === +matterId);
  }

  function day(date) {
    const [start, end] = T.dayBounds(date);
    const now = Date.now();
    const raw = new Map();
    for (const s of segmentsForDay(date)) {
      raw.set(s.matter_id, (raw.get(s.matter_id) ?? 0) + Math.max(Math.min(s.end_ms ?? now, end) - Math.max(s.start_ms, start), 0));
    }
    for (const e of db.entries.values()) if (e.date === date && !raw.has(e.matter_id)) raw.set(e.matter_id, 0);
    const run = running();
    const entries = [];
    for (const [matterId, rawMs] of raw) {
      const matter = getMatter(matterId);
      const rules = rulesFor(matter);
      const usesCodes = !!matter.code_set;
      const computed = T.roundHours(rawMs, config.rounding);
      const rows = partsOf(date, matterId);
      if (!rows.some((r) => r.part === 0)) rows.unshift(getEntry(date, matterId, 0));
      const splitHours = round2(rows.filter((r) => r.part > 0).reduce((s, r) => s + (r.hours_override ?? 0), 0));
      const remainder = round2(computed - splitHours);
      for (const row of rows) {
        const isMain = row.part === 0;
        entries.push({
          ...row,
          matter,
          rules,
          task: usesCodes ? row.task_code || matter.task_code : '',
          activity: usesCodes ? row.activity_code || matter.activity_code : '',
          ai: config.aiUse?.enabled ? (row.ai_used || config.aiUse.default) === 'yes' : null,
          raw_ms: isMain ? rawMs : 0,
          computed_hours: computed,
          split_hours: splitHours,
          over_allocated: isMain && row.hours_override == null && remainder < 0,
          parts: rows.length,
          hours: isMain ? (row.hours_override ?? Math.max(remainder, 0)) : row.hours_override,
          block_warning: rules.no_block_billing && B.looksBlockBilled(row.narrative),
          running: isMain && run?.matter_id === matterId,
        });
      }
    }
    entries.sort((a, b) => a.matter.name.localeCompare(b.matter.name) || a.part - b.part);
    return { date, entries, total_hours: round2(entries.reduce((s, e) => s + e.hours, 0)) };
  }

  function state() {
    const run = running();
    const today = T.localDate();
    const { entries, total_hours } = day(today);
    const todayMs = Object.fromEntries(entries.filter((e) => e.part === 0).map((e) => [e.matter_id, e.raw_ms]));
    return {
      now: Date.now(),
      today,
      total_hours,
      running: run ? { ...run, matter: getMatter(run.matter_id), tasks_today: taskBlocks(today, run.matter_id).length } : null,
      matters: listMatters().map((m) => ({ ...m, today_ms: todayMs[m.id] ?? 0 })),
      dictation: { ...db.dictation },
      mic_verified: true, // dictation is simulated in the demo
      deck: deck(),
      daily_target: Number(config.dailyTarget) || 0,
    };
  }

  // ---------- drafting ----------
  // The same instant drafter the app uses (inlined as D by the demo build), so
  // what you see here is what deck-time does. Codes use simple keyword rules.

  function pickCodes(text, codes) {
    const t = text.toLowerCase();
    const has = (re) => re.test(t);
    const call = has(/telephone|call|conference|meeting|met with/);
    let activity = 'A104';
    if (call) activity = has(/client|general counsel|chief|committee|board|cfo/) ? 'A106' : has(/counsel/) ? 'A107' : 'A108';
    else if (has(/drafted|revised|prepared|email|letter|memo|responses/)) activity = 'A103';
    else if (has(/research/)) activity = 'A102';
    const tasks = Object.keys(codes.tasks);
    let task;
    if (tasks[0].startsWith('L')) {
      task = has(/interrogator|requests for admission/) ? 'L310' : has(/production|privilege/) ? 'L320' : has(/deposition/) ? 'L330'
        : has(/meet and confer|deficienc/) ? 'L390' : has(/motion/) ? 'L250' : has(/settle|mediat/) ? 'L160' : 'L120';
    } else {
      task = has(/research/) ? 'C200' : has(/gather|collect/) ? 'C100' : call && has(/opposing|bank|lender|counsel to/) ? 'C400' : 'C300';
    }
    return { task_code: tasks.includes(task) ? task : tasks[0], activity_code: activity in codes.activities ? activity : 'A104' };
  }

  const codesFor = (matter) => (matter?.code_set && config.codes.taskSets[matter.code_set] ? { tasks: config.codes.taskSets[matter.code_set].codes, activities: config.codes.activities } : null);

  // ---------- teacher (simulated: the installed app asks a local model; here, the rules it found on the demo edits) ----------

  const teach = { rules: [], proposals: null, lastRun: null, running: false };
  const keyOf = (m) => [m?.client_no, m?.matter_no].filter(Boolean).join('.');
  const TEACHER_FINDINGS = [
    { id: 'demo-1', type: 'verb', from: 'redline', to: 'redlined', reason: '"Redline" is consistently billed in the past tense.', evidence: { improved: 2, worsened: 0, matters: ['20411.0002', '52009.0004'], examples: [{ before: 'Redline credit agreement per lender comments.', after: 'Redlined credit agreement per lender comments.', final: 'Redlined credit agreement per lender comments.' }] } },
    { id: 'demo-2', type: 'phrase', from: 'board deck', to: 'board presentation', matter: '41120.0001', reason: 'On Stark, a board deck is always billed as a board presentation.', evidence: { improved: 2, worsened: 0, matters: ['41120.0001'], examples: [{ before: 'Prepared board deck for stark meeting.', after: 'Prepared board presentation for stark meeting.', final: 'Prepared board presentation for Stark meeting.' }] } },
    { id: 'demo-3', type: 'phrase', from: 'deal team', to: 'working group', matter: '10234.0007', reason: 'On Acme, the deal team is billed as the working group.', evidence: { improved: 2, worsened: 0, matters: ['10234.0007'], examples: [{ before: 'Emailed deal team regarding open points on stock purchase agreement.', after: 'Emailed working group regarding open points on stock purchase agreement.', final: 'Emailed working group regarding open points on stock purchase agreement.' }] } },
  ];
  const teacherStatus = () => ({ running: teach.running, edits: 9, ready: true, model: 'simulated', lastRun: teach.lastRun, proposals: teach.proposals ?? [], rules: teach.rules });
  /** Drafting options from accepted rules (the installed app's phrasebook does this). */
  function taughtOpts(matterId) {
    const key = keyOf(getMatter(matterId));
    const phrases = {};
    const verbs = {};
    for (const r of teach.rules.filter((x) => !x.matter || x.matter === key)) (r.type === 'verb' ? verbs : phrases)[r.from] = r.to;
    return { phrases, verbs };
  }

  function draft(date, matterId, part) {
    const e = getEntry(date, matterId, part);
    if (!e.notes.trim()) throw err(400, 'Add a few words of notes first');
    const narrative = D.draftNarrative(e.notes, taughtOpts(matterId));
    const saved = updateEntry(date, matterId, { narrative }, part);
    emit('drafted');
    const codes = codesFor(getMatter(matterId));
    return codes && !(saved.task_code && saved.activity_code) ? updateEntry(date, matterId, pickCodes(narrative, codes), part) : saved;
  }

  function proposeSplit(date, matterId) {
    const matter = getMatter(matterId);
    const rows = day(date).entries.filter((e) => e.matter_id === +matterId);
    const totalHours = rows.find((e) => e.part === 0)?.computed_hours || rows.reduce((s, e) => s + e.hours, 0);
    if (!(totalHours > 0)) throw err(400, 'No time recorded for this matter today');
    const codes = codesFor(matter);
    const blocks = taskBlocks(date, +matterId);
    const withCodes = (item) => (codes && item.narrative ? { ...item, ...pickCodes(item.narrative, codes) } : item);
    if (blocks.length > 1) {
      const total = Math.max(totalHours, round2(blocks.length * config.rounding.minimum));
      const sized = A.normalizeSplit(blocks.map((b) => ({ ...b, hours: b.ms / 3_600_000 })), total, config.rounding.increment);
      return {
        mode: 'tasks',
        total_hours: total,
        entries: sized.map((b) => {
          const notes = b.notes.map((n) => n.text).join('; ');
          return withCodes({ notes, narrative: notes ? D.draftNarrative(notes, taughtOpts(matterId)) : '', hours: b.hours, task: b.task, range: [b.start, b.end] });
        }),
      };
    }
    const clauses = rows.map((e) => e.notes).join('; ').split(';').map((s) => s.trim()).filter(Boolean);
    if (clauses.length < 2) throw err(400, 'Only one task in the notes. Add notes for each task, or use Next task while you work.');
    const weight = (c) => (/call|conference|meeting/i.test(c) ? 1 : /email|letter/i.test(c) ? 1.5 : 3);
    const sized = A.normalizeSplit(clauses.map((c) => ({ notes: c, hours: weight(c) })), totalHours, config.rounding.increment);
    return { mode: 'estimate', total_hours: totalHours, entries: sized.map((e) => withCodes({ ...e, narrative: D.draftNarrative(e.notes, taughtOpts(matterId)) })) };
  }

  // ---------- simulated dictation ----------

  const SCRIPTS = {
    acme: [
      'Reviewing the target disclosure schedules against the reps in the merger agreement',
      'Drafting an email to the deal team about open issues on the disclosure schedules',
      'Call with opposing counsel about the closing conditions',
    ],
    initech: ['Marking up the lender draft of the credit agreement, focusing on the financial covenants', 'Call with the client CFO about covenant headroom'],
    umbrella: ['Reviewing the defendant document production for privilege issues', 'Drafting a meet and confer letter on deficiencies in the production'],
    stark: ['Preparing the agenda and resolutions for the next board meeting', 'Call with the general counsel about the stock plan amendment'],
    wayne: ['Reviewing the bank fairness opinion draft and valuation analyses', 'Email to the special committee chair summarizing comments on the opinion'],
    admin: ['CLE webinar on recent Delaware fiduciary duty decisions'],
  };
  const spoken = new Map();
  let dictTimer = null;

  function nextPhrase(matter) {
    const list = SCRIPTS[matter.script] ?? ['Reviewed correspondence and updated the file'];
    const i = spoken.get(matter.id) ?? 0;
    spoken.set(matter.id, i + 1);
    return list[i % list.length];
  }

  function dictationToggle() {
    const d = db.dictation;
    if (d.status === 'recording') return finishDictation();
    if (d.status === 'transcribing') return { busy: true };
    const run = running();
    if (!run) throw err(400, 'Start a timer first. Dictation goes into the running matter’s notes.');
    const matter = getMatter(run.matter_id);
    const phrase = nextPhrase(matter);
    Object.assign(d, { status: 'recording', error: null, started_at: Date.now(), matterId: matter.id, phrase });
    emit('listening', { matter, phrase });
    dictTimer = setTimeout(finishDictation, Math.min(5200, 1400 + phrase.length * 45));
    changed();
    return { recording: true };
  }

  async function finishDictation() {
    const d = db.dictation;
    if (d.status !== 'recording') return {};
    clearTimeout(dictTimer);
    d.status = 'transcribing';
    changed();
    await sleep(650);
    addNote(d.phrase, d.matterId, 'dictated', d.started_at); // timestamped when speaking began
    emit('dictated', { text: d.phrase, matter: getMatter(d.matterId) });
    Object.assign(d, { status: 'idle', started_at: null, last: { text: d.phrase, matter_id: d.matterId, at: Date.now() } });
    changed();
    return { text: d.phrase };
  }

  // ---------- routes ----------

  const E = '(\\d{4}-\\d{2}-\\d{2})\\/(\\d+)';
  const routes = [
    ['GET', '/api/state', () => ({ ...state(), mic_verified: true })],
    ['GET', '/api/config', () => config],
    ['PUT', '/api/config', (b) => {
      const merge = (t, s) => { for (const [k, v] of Object.entries(s)) t[k] = v && typeof v === 'object' && !Array.isArray(v) && k !== 'defaults' ? merge(t[k] ?? {}, v) : v; return t; };
      return merge(config, b);
    }],
    ['GET', '/api/ai/status', () => ({ reachable: false, installed: false, model: 'not used', models: [] })],
    ['GET', '/api/phrasebook', () => ({ corrections: 0, learned: [], active: 0 })],
    ['GET', '/api/teacher', () => teacherStatus()],
    ['POST', '/api/teacher/run', async () => {
      teach.running = true;
      await sleep(2500); // the real review takes about a minute on a local model
      teach.running = false;
      const decided = new Set([...teach.rules.map((r) => r.id), ...(teach.rejected ?? [])]);
      teach.proposals = TEACHER_FINDINGS.filter((p) => !decided.has(p.id));
      teach.lastRun = { at: Date.now(), reviewed: 9, suggested: 12, kept: teach.proposals.length, dropped: [
        { type: 'fix', from: 'Reviewed', to: 'Analyzed', why: 'only one past draft supports it' },
        { type: 'phrase', from: 'mtd', to: 'motion to strike', why: 'adds words you never used (strike)' },
      ] };
      return teacherStatus();
    }],
    ['POST', /^\/api\/teacher\/proposals\/([\w-]+)$/, (b, _, [id]) => {
      const i = (teach.proposals ?? []).findIndex((p) => p.id === id);
      if (i < 0) throw err(404, 'Proposal not found');
      const [p] = teach.proposals.splice(i, 1);
      if (b.action === 'accept') teach.rules.push(p);
      else (teach.rejected ??= []).push(p.id);
      return teacherStatus();
    }],
    ['DELETE', /^\/api\/teacher\/rules\/([\w-]+)$/, (_, __, [id]) => {
      teach.rules = teach.rules.filter((r) => r.id !== id);
      (teach.rejected ??= []).push(id);
      return teacherStatus();
    }],
    ['GET', '/api/codes/memory', () => ({ examples: 0, bySource: {}, codeSets: [] })],
    ['POST', '/api/tim/learn', () => { throw err(400, 'Learning from an Intapp export works in the installed app.'); }],
    ['GET', '/api/matters', (_, q) => listMatters(q.get('all') === '1')],
    ['POST', '/api/matters', (b) => createMatter(b)],
    ['PATCH', /^\/api\/matters\/(\d+)$/, (b, _, [id]) => updateMatter(id, b)],
    ['GET', '/api/deck', () => deck()],
    ['PUT', /^\/api\/deck\/(\d+)$/, (b, _, [slot]) => setDeckSlot(+slot, b)],
    ['POST', '/api/deck/swap', (b) => swapDeckSlots(+b.from, +b.to)],
    ['GET', '/api/clients', () => listClients()],
    ['PUT', /^\/api\/clients\/([^/]+)$/, (b, _, [no]) => updateClient(decodeURIComponent(no), b)],
    ['POST', '/api/timer/toggle', (b) => toggle(+b.matter_id)],
    ['POST', '/api/timer/stop', () => stop()],
    ['POST', '/api/timer/note', (b) => { const r = addNote(String(b.text ?? ''), b.matter_id ? +b.matter_id : undefined); emit('noted'); return r; }],
    ['POST', '/api/timer/next-task', (b) => nextTask(b.label ? String(b.label) : '')],
    ['POST', /^\/api\/dictation\/(toggle|start|stop)$/, (_, __, [op]) => (op === 'stop' ? finishDictation() : op === 'start' && db.dictation.status === 'recording' ? { recording: true } : dictationToggle())],
    ['GET', '/api/day', (_, q) => day(q.get('date') || T.localDate())],
    ['GET', '/api/segments', (_, q) => segmentsForDay(q.get('date') || T.localDate())],
    ['POST', '/api/segments', (b) => {
      if (!(b.end_ms > b.start_ms)) throw err(400, 'End must be after start');
      db.segments.push({ id: seq++, matter_id: +b.matter_id, start_ms: b.start_ms, end_ms: b.end_ms, task: 0 });
      changed();
    }],
    ['PATCH', /^\/api\/segments\/(\d+)$/, (b, _, [id]) => { Object.assign(db.segments.find((s) => s.id === +id) ?? {}, pick(b, ['start_ms', 'end_ms', 'matter_id'])); changed(); }],
    ['DELETE', /^\/api\/segments\/(\d+)$/, (_, __, [id]) => { db.segments = db.segments.filter((s) => s.id !== +id); changed(); }],
    ['PATCH', new RegExp(`^\\/api\\/entries\\/${E}(?:\\/(\\d+))?$`), (b, _, [d, m, p]) => updateEntry(d, +m, b, +(p ?? 0))],
    ['DELETE', new RegExp(`^\\/api\\/entries\\/${E}\\/(\\d+)$`), (_, __, [d, m, p]) => deletePart(d, +m, +p)],
    ['POST', new RegExp(`^\\/api\\/entries\\/${E}\\/parts$`), (b, _, [d, m]) => addPart(d, +m, b)],
    ['POST', new RegExp(`^\\/api\\/entries\\/${E}(?:\\/(\\d+))?\\/narrate$`), (_, __, [d, m, p]) => draft(d, +m, +(p ?? 0))],
    ['POST', new RegExp(`^\\/api\\/entries\\/${E}(?:\\/(\\d+))?\\/codes$`), async (_, __, [d, m, p]) => {
      const codes = codesFor(getMatter(m));
      if (!codes) throw err(400, 'This matter does not use task/activity codes');
      const e = getEntry(d, +m, +(p ?? 0));
      return updateEntry(d, +m, pickCodes(e.narrative || e.notes, codes), +(p ?? 0));
    }],
    ['POST', new RegExp(`^\\/api\\/entries\\/${E}\\/split\\/propose$`), (_, __, [d, m]) => proposeSplit(d, +m)],
    ['POST', new RegExp(`^\\/api\\/entries\\/${E}\\/split\\/apply$`), (b, _, [d, m]) => applySplit(d, +m, b.entries)],
    ['POST', '/api/export', (b) => {
      const format = b.format === 'csv' ? 'csv' : 'tim';
      const entries = X.exportable(day(b.date).entries, { includeExported: !!b.includeExported });
      if (!entries.length) throw err(400, 'Nothing to export for that day');
      const problems = format === 'csv' ? entries.filter((e) => !e.narrative.trim()).map((e) => `${e.matter.name}: missing narrative`) : X.validateForTim(entries, config);
      if (problems.length) throw err(400, `Can't export yet: ${problems.join('; ')}`);
      const warnings = entries.filter((e) => e.block_warning).map((e) => `${e.matter.name}: looks block-billed, but this client prohibits it`);
      if (warnings.length && !b.force) throw Object.assign(err(409, warnings.join('; ')), { warnings });
      const body = format === 'csv' ? X.toCsv(entries) : X.toTim(entries, config);
      const filename = `deck-time-${b.date}.${format === 'csv' ? 'csv' : 'TIM'}`;
      for (const e of entries) updateEntry(b.date, e.matter_id, { status: 'exported' }, e.part);
      emit('exported', { filename, body, count: entries.length, format });
      return { filename, savedTo: 'the preview window', count: entries.length, body };
    }],
  ];

  async function handle(method, url, body) {
    for (const [m, pattern, fn] of routes) {
      if (m !== method) continue;
      const match = typeof pattern === 'string' ? (url.pathname === pattern ? [] : null) : url.pathname.match(pattern)?.slice(1);
      if (match) return (await fn(body ?? {}, url.searchParams, match)) ?? { ok: true };
    }
    throw err(404, 'Not found');
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    try {
      const data = await handle(method, url, init.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      return new Response(JSON.stringify({ error: e.message, ...(e.warnings ? { warnings: e.warnings } : {}) }), { status, headers: { 'Content-Type': 'application/json' } });
    }
  };

  // Live updates: the real app streams state over Server-Sent Events.
  const streams = new Set();
  class DemoEventSource {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      streams.add(this);
      setTimeout(() => this.push(), 0);
    }
    push() {
      this.onmessage?.({ data: JSON.stringify(state()) });
    }
    addEventListener() {} // named events (the Review key's 'show') need a Stream Deck; none in the demo
    close() {
      streams.delete(this);
    }
  }
  window.EventSource = DemoEventSource;

  let pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      streams.forEach((s) => s.push());
      emit('state', state());
    });
  }
  setInterval(() => {
    streams.forEach((s) => s.push());
    emit('tick', state());
  }, 1000);

  // ---------- sample day ----------

  function seed() {
    blank();
    const acme = createMatter({ name: 'Acme / Globex Merger', label: 'Acme M&A', client_no: '10234', matter_no: '0007', color: '#2f5d8a', script: 'acme' });
    const initech = createMatter({ name: 'Initech Credit Facility', label: 'Initech Loan', client_no: '20411', matter_no: '0002', color: '#3f7d52', script: 'initech' });
    const umbrella = createMatter({ name: 'Umbrella v. Hooli', label: 'Umbrella Lit.', client_no: '30877', matter_no: '0015', color: '#9a3b36', code_set: 'litigation', script: 'umbrella' });
    const stark = createMatter({ name: 'Stark Industries Board', label: 'Stark Board', client_no: '41120', matter_no: '0001', color: '#6b4f8a', script: 'stark' });
    const wayne = createMatter({ name: 'Wayne Ent. Fairness Opinion', label: 'Wayne FO', client_no: '52009', matter_no: '0004', color: '#b0702a', script: 'wayne' });
    createMatter({ name: 'Firm Admin (non-billable)', label: 'Admin', client_no: '99999', matter_no: '0000', color: '#7a7a74', script: 'admin' });
    updateClient('10234', {
      name: 'Acme Corp',
      no_block_billing: true,
      guidelines: 'Separate legal analysis, the internal email reporting that analysis, and any call about it into distinct entries.',
    });
    updateClient('30877', { name: 'Umbrella Corp', guidelines: 'UTBMS litigation codes required on every entry.' });

    // Earlier today, placed relative to now so it always lands in the past.
    const now = Date.now();
    // The sample morning spans ~4 hours. Early in the day, squeeze it into the
    // time since midnight so it always lands on today.
    const sinceMidnight = (now - new Date(now).setHours(0, 0, 0, 0)) / MIN;
    const squeeze = sinceMidnight < 245 ? Math.max(0.05, (sinceMidnight - 5) / 240) : 1;
    const at = (minAgo) => now - minAgo * MIN * squeeze;
    const seg = (m, from, to, task = 0) => db.segments.push({ id: seq++, matter_id: m.id, start_ms: at(from), end_ms: at(to), task });
    const note = (m, minAgo, text) => addNote(text, m.id, 'dictated', at(minAgo));
    const date = T.localDate(at(230));

    seg(stark, 232, 200);
    note(stark, 231, 'rev draft board minutes; comments to GC');
    updateEntry(date, stark.id, { narrative: 'Reviewed draft board minutes and provided comments to general counsel.', status: 'ready' });

    seg(initech, 192, 151);
    note(initech, 190, 'rev lender comments to credit agmt; issues list for client');

    // Three tasks marked with Next task: analysis, internal email, client call.
    seg(acme, 140, 96, 0);
    seg(acme, 96, 83, 1);
    seg(acme, 83, 71, 2);
    note(acme, 139, 'analyzed MAC clause and termination rights in merger agmt');
    note(acme, 96, 'email to deal team summarizing MAC analysis');
    note(acme, 83, 'call w/ client GC re same');

    seg(umbrella, 62, 24);
    note(umbrella, 61, 'drafted responses to second set of interrogatories');
    spoken.clear();
  }

  seed();
  window.deckDemo = {
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    reset: () => {
      clearTimeout(dictTimer);
      seed();
      changed();
      emit('reset');
    },
    state,
  };
})();
