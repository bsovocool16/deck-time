import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiStatus, normalizeSplit } from './ai.js';
import { draftClauses, draftNarrative } from './drafter.js';
import { Phrasebook } from './phrasebook.js';
import { CodeMemory, examplesFromTim } from './coder.js';
import { codesFor } from './codes.js';
import { EXPORT_DIR, deepMerge } from './config.js';
import { dictationPrompt } from './dictation.js';
import { exportable, learnFromTim, parseTim, toCsv, toTim, validateForTim } from './export.js';
import { httpError } from './store.js';
import { isDate } from './time.js';

const DEMO_TIMEKEEPER = { id: '10001', name: 'Demo Attorney' };
const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export function createServer({
  store,
  getConfig,
  setConfig,
  fetchImpl = fetch,
  exportDir = EXPORT_DIR,
  dictation = null,
  publicDir = DEFAULT_PUBLIC_DIR,
  workspace = null, // { get(), set(name), resetDemo() } when real/demo switching is available
  coder = new CodeMemory(), // learned task/activity codes (see coder.js)
  phrasebook = new Phrasebook(), // learned phrasing for the instant drafter (see phrasebook.js)
}) {
  const clients = new Set();
  // What the Stream Deck plugin reports is actually on each key (in memory; the
  // plugin re-sends after reconnecting). null until a deck reports in.
  let physical = null;
  const PHYSICAL_KINDS = new Set(['key', 'matter', 'dictate', 'next-task', 'stop', 'review']);
  const LABELS = { matter: 'a matter', dictate: 'Dictate', 'next-task': 'Next task', stop: 'Stop', review: 'Review', none: 'another action' };

  /** The layout as the device shows it: deck-time Keys follow the app; anything else is fixed. */
  function effectiveDeck() {
    const deck = store.deck();
    if (!physical) return deck;
    return deck.map((s) => {
      const p = physical.get(s.slot);
      if (p?.kind === 'key') return { ...s, fixed: false };
      if (p) return { slot: s.slot, kind: p.kind, matter_id: p.kind === 'matter' ? p.matter_id : null, fixed: true };
      return { slot: s.slot, kind: 'none', matter_id: null, fixed: true };
    });
  }

  function assertMovable(...slots) {
    for (const slot of slots) {
      const s = effectiveDeck()[slot];
      if (s?.fixed) {
        throw httpError(409, `Key ${slot + 1} is set to ${LABELS[s.kind]} in the Stream Deck app. To arrange it from here, put a deck-time Key action on it.`);
      }
    }
  }
  store.on('change', () => broadcast());
  dictation?.on('change', () => broadcast());
  // A silent recording means the microphone needs attention again.
  dictation?.on('nosound', () => setConfig(deepMerge(getConfig(), { dictation: { verified: false } })));
  const fullState = () => ({
    ...store.state(),
    deck: effectiveDeck(),
    dictation: dictation?.snapshot() ?? null,
    mic_verified: !!dictation && getConfig().dictation?.verified === true,
    workspace: workspace?.get() ?? 'real',
  });
  const matterKey = (m) => [m.client_no, m.matter_no].filter(Boolean).join('.');
  /** Instant codes for an entry: learned from your history, else keyword rules. No AI. */
  const instantCodes = (matter, text) => {
    const codes = codesFor(matter, getConfig());
    return codes && text?.trim() ? coder.suggest(text, codes, { codeSet: matter.code_set, matter: matterKey(matter) }) : null;
  };
  /** Fill codes the entry doesn't have yet (never overwrites ones you chose). */
  const fillMissingCodes = (date, matterId, part) => {
    const matter = store.getMatter(matterId);
    const e = store.getEntry(date, matterId, part);
    if (!matter?.code_set || (e.task_code && e.activity_code)) return e;
    const picked = instantCodes(matter, e.narrative || e.notes);
    if (!picked) return e;
    return store.updateEntry(date, matterId, { task_code: e.task_code || picked.task_code, activity_code: e.activity_code || picked.activity_code }, part);
  };
  // Tick so running timers refresh even with no changes.
  const ticker = setInterval(() => clients.size && broadcast(), 1000);

  function broadcast() {
    const data = `data: ${JSON.stringify(fullState())}\n\n`;
    for (const res of clients) res.write(data);
  }

  const routes = [
    ['GET', /^\/api\/state$/, () => fullState()],
    ['POST', /^\/api\/dictation\/(toggle|start|stop)$/, (_, __, [op]) => {
      if (!dictation) throw httpError(501, 'Dictation not available');
      if (op === 'stop') return dictation.stop().then((text) => ({ text }));
      if (dictation.status === 'recording') return op === 'toggle' ? dictation.stop().then((text) => ({ text })) : { recording: true };
      const running = store.running();
      if (!running) throw httpError(400, 'Start a timer first; dictation goes into its notes');
      const matter = store.getMatter(running.matter_id);
      const hint = dictationPrompt(matter, { matters: store.listMatters(), vocabulary: getConfig().dictation?.vocabulary, extra: phrasebook.vocabulary() });
      dictation.start({ matterId: matter.id, ...hint, startedAt: store.now() });
      return { recording: true };
    }],
    ['GET', /^\/api\/matters$/, (_, q) => store.listMatters({ includeArchived: q.get('all') === '1' })],
    ['POST', /^\/api\/matters$/, (b) => store.createMatter(b)],
    ['PATCH', /^\/api\/matters\/(\d+)$/, (b, _, [id]) => store.updateMatter(+id, b)],
    ['POST', /^\/api\/timer\/toggle$/, (b) => store.toggle(+b.matter_id)],
    ['POST', /^\/api\/timer\/stop$/, () => store.stop()],
    ['POST', /^\/api\/timer\/next-task$/, (b) => store.nextTask(b.label ? String(b.label) : '')],
    ['POST', /^\/api\/timer\/overnight\/(\d+)$/, (b, _, [id]) => store.resolveOvernight(+id, b)],
    ['POST', /^\/api\/timer\/note$/, (b) => store.addNote(String(b.text ?? ''), b.matter_id ? +b.matter_id : undefined)],
    ['GET', /^\/api\/day$/, (_, q) => store.day(dateParam(q, store))],
    ['GET', /^\/api\/segments$/, (_, q) => store.segmentsForDay(dateParam(q, store))],
    ['POST', /^\/api\/segments$/, (b) => store.addSegment(b)],
    ['PATCH', /^\/api\/segments\/(\d+)$/, (b, _, [id]) => store.updateSegment(+id, b)],
    ['DELETE', /^\/api\/segments\/(\d+)$/, (_, __, [id]) => store.deleteSegment(+id)],
    // Entries: /api/entries/:date/:matter[/:part] — part 0 (default) is the main entry.
    ['PATCH', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)(?:\/(\d+))?$/, (b, _, [date, id, part]) => {
      const saved = store.updateEntry(date, +id, b, +(part ?? 0));
      // A new or edited narrative on a coded matter gets codes right away if it has none.
      return 'narrative' in b ? fillMissingCodes(date, +id, +(part ?? 0)) : saved;
    }],
    ['DELETE', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/(\d+)$/, (_, __, [date, id, part]) => store.deletePart(date, +id, +part)],
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/parts$/, (b, _, [date, id]) => store.addPart(date, +id, b)],
    // Instant draft from notes: rules + your phrasebook, no AI model (see drafter.js).
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)(?:\/(\d+))?\/narrate$/, (_, __, [date, id, part]) => {
      const matterId = +id;
      const p = +(part ?? 0);
      const matter = store.getMatter(matterId);
      if (!matter) throw httpError(404, 'Matter not found');
      const { notes } = store.getEntry(date, matterId, p);
      if (!notes?.trim()) throw httpError(400, 'Add a few words of notes first, typed or dictated');
      const narrative = draftNarrative(notes, phrasebook.options(matterKey(matter)));
      // Keep the draft so we can learn from how you change it before export.
      store.updateEntry(date, matterId, { narrative, draft: narrative }, p);
      return fillMissingCodes(date, matterId, p);
    }],
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)(?:\/(\d+))?\/codes$/, (_, __, [date, id, part]) => {
      const matterId = +id;
      const p = +(part ?? 0);
      const matter = store.getMatter(matterId);
      if (!codesFor(matter, getConfig())) throw httpError(400, 'This matter does not use task/activity codes');
      const { narrative, notes } = store.getEntry(date, matterId, p);
      const picked = instantCodes(matter, narrative || notes);
      if (!picked) throw httpError(400, 'Write a narrative or notes first');
      const saved = store.updateEntry(date, matterId, { task_code: picked.task_code, activity_code: picked.activity_code }, p);
      return { ...saved, code_source: picked.source };
    }],
    ['GET', /^\/api\/codes\/memory$/, () => coder.stats()],
    ['GET', /^\/api\/phrasebook$/, () => ({ ...phrasebook.stats(), learned: phrasebook.list(50) })],
    ['POST', /^\/api\/codes\/import$/, (b) => {
      const files = Array.isArray(b.files) ? b.files : [String(b.text ?? '')];
      const examples = files.flatMap((text) => examplesFromTim(parseTim(String(text)), 'import'));
      if (!examples.length) throw httpError(400, 'No coded entries found. Choose .TIM files exported from Intapp Time that include task and activity codes.');
      const added = coder.add(examples);
      return { found: examples.length, added, ...coder.stats() };
    }],
    // Block billing: propose a split (not saved), then apply the reviewed version. Instant; no AI model.
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/split\/propose$/, (_, __, [date, id]) => {
      const matterId = +id;
      const matter = store.getMatter(matterId);
      if (!matter) throw httpError(404, 'Matter not found');
      const rows = store.day(date).entries.filter((e) => e.matter_id === matterId);
      const main = rows.find((e) => e.part === 0);
      const totalHours = main?.computed_hours || rows.reduce((s, e) => s + e.hours, 0);
      if (!(totalHours > 0)) throw httpError(400, 'No time recorded for this matter today');
      const config = getConfig();
      const inc = config.rounding.increment;
      const draftOpts = phrasebook.options(matterKey(matter));
      const withCodes = (item) => (item.narrative ? { ...item, ...(instantCodes(matter, item.narrative) ?? {}) } : item);
      const blocks = store.taskBlocks(date, matterId);

      if (blocks.length > 1) {
        // Tasks were marked with "Next task": durations are exact. Each marked task gets at least the minimum.
        const total = Math.max(totalHours, Math.round(blocks.length * Math.max(inc, config.rounding.minimum) * 100) / 100);
        const sized = normalizeSplit(blocks.map((b) => ({ ...b, hours: b.ms / 3_600_000 })), total, inc);
        const entries = sized.map((b) => {
          const notes = b.notes.map((n) => n.text).join('; ');
          const narrative = notes ? draftNarrative(notes, draftOpts) : '';
          return withCodes({ notes, narrative, draft: narrative, hours: b.hours, task: b.task, range: [b.start, b.end] });
        });
        return { mode: 'tasks', total_hours: total, entries };
      }

      // No marked tasks: one entry per clause of your notes, with time weighted by kind of work.
      const clauses = draftClauses(rows.map((e) => e.notes).filter(Boolean).join('; '), draftOpts);
      if (clauses.length < 2) throw httpError(400, 'Only one task in the notes. Mark tasks with Next task as you work, or use Add split.');
      const weight = (c) => (/call|telephone|conference|meeting|\bmtg\b|\btc\b/i.test(c) ? 1 : /email|e-mail|letter|sent|send/i.test(c) ? 1.5 : 3);
      const sized = normalizeSplit(clauses.map((c) => ({ ...c, hours: weight(c.notes) })), totalHours, inc);
      return { mode: 'estimate', total_hours: totalHours, entries: sized.map((c) => withCodes({ ...c, draft: c.narrative })) };
    }],
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/split\/apply$/, (b, _, [date, id]) => store.applySplit(date, +id, b.entries)],
    ['POST', /^\/api\/dictation\/test$/, async () => {
      if (!dictation) throw httpError(501, 'Dictation is not available in this edition');
      const result = await dictation.testMic(3);
      setConfig(deepMerge(getConfig(), { dictation: { verified: result.heard } }));
      broadcast();
      return { ...result, platform: process.platform };
    }],
    ['POST', /^\/api\/system\/microphone-settings$/, () => openMicrophoneSettings()],
    ['GET', /^\/api\/workspace$/, () => ({ workspace: workspace?.get() ?? 'real', available: !!workspace })],
    ['POST', /^\/api\/workspace$/, (b) => {
      if (!workspace) throw httpError(501, 'Demo day is not available here');
      store.stop(); // don't leave a timer running in the workspace you're leaving
      return workspace.set(b.workspace);
    }],
    ['POST', /^\/api\/workspace\/reset-demo$/, () => {
      if (!workspace) throw httpError(501, 'Demo day is not available here');
      return workspace.resetDemo();
    }],
    ['GET', /^\/api\/deck$/, () => effectiveDeck()],
    ['PUT', /^\/api\/deck\/(\d+)$/, (b, _, [slot]) => {
      assertMovable(+slot);
      store.setDeckSlot(+slot, b);
      return effectiveDeck();
    }],
    ['POST', /^\/api\/deck\/swap$/, (b) => {
      assertMovable(+b.from, +b.to);
      store.swapDeckSlots(+b.from, +b.to);
      return effectiveDeck();
    }],
    ['POST', /^\/api\/deck\/physical$/, (b) => {
      const slots = Array.isArray(b.slots) ? b.slots : [];
      physical = new Map(
        slots
          .filter((s) => Number.isInteger(s.slot) && s.slot >= 0 && PHYSICAL_KINDS.has(s.kind))
          .map((s) => [s.slot, { kind: s.kind, matter_id: s.matter_id == null ? null : +s.matter_id }]),
      );
      broadcast();
      return { ok: true, keys: physical.size };
    }],
    ['GET', /^\/api\/clients$/, () => store.listClients()],
    ['PUT', /^\/api\/clients\/([^/]+)$/, (b, _, [no]) => store.updateClient(decodeURIComponent(no), b)],
    ['POST', /^\/api\/export$/, (b) => exportDay(b)],
    ['GET', /^\/api\/ai\/status$/, () => aiStatus(getConfig(), fetchImpl)],
    ['POST', /^\/api\/tim\/learn$/, (b) => {
      const learned = learnFromTim(String(b.text ?? ''));
      const cfg = getConfig();
      // Replace (not merge) the defaults so stale keys don't linger.
      setConfig({
        ...cfg,
        timekeeper: { ...cfg.timekeeper, id: cfg.timekeeper.id || learned.timekeeperId },
        tim: { ...cfg.tim, defaults: learned.defaults, ssPrefix: learned.ssPrefix },
      });
      return { entries: learned.entries, timekeeperId: learned.timekeeperId, unknownVarying: learned.unknownVarying };
    }],
    ['GET', /^\/api\/config$/, () => getConfig()],
    ['PUT', /^\/api\/config$/, (b) => {
      const next = deepMerge(getConfig(), b);
      if (b.tim?.defaults) next.tim.defaults = b.tim.defaults;
      return setConfig(next);
    }],
  ];

  function exportDay({ date, format = 'tim', includeExported = false, markExported = true, force = false }) {
    if (!isDate(date)) throw httpError(400, 'date must be YYYY-MM-DD');
    // Demo day exports carry a fictional timekeeper, so they're safe to show.
    const config = workspace?.get() === 'demo' ? { ...getConfig(), timekeeper: DEMO_TIMEKEEPER } : getConfig();
    const entries = exportable(store.day(date).entries, { includeExported });
    if (!entries.length) throw httpError(400, 'Nothing to export for that day');
    const problems = format === 'csv' ? entries.filter((e) => !e.narrative.trim()).map((e) => `${e.matter.name}: missing narrative`) : validateForTim(entries, config);
    if (problems.length) throw httpError(400, `Can't export yet: ${problems.join('; ')}`);
    const warnings = entries.filter((e) => e.block_warning).map((e) => `${e.matter.name}: looks block-billed, but this client prohibits it`);
    if (warnings.length && !force) throw Object.assign(httpError(409, warnings.join('; ')), { warnings });
    const body = format === 'csv' ? toCsv(entries) : toTim(entries, config);
    const filename = `deck-time-${date}.${format === 'csv' ? 'csv' : 'tim'}`;
    fs.mkdirSync(exportDir, { recursive: true });
    const savedTo = path.join(exportDir, filename);
    fs.writeFileSync(savedTo, body);
    if (markExported) for (const e of entries) store.updateEntry(date, e.matter_id, { status: 'exported' }, e.part);
    // Every export teaches the code memory how you code, and the phrasebook how you
    // phrase things (what you changed from the instant draft). Never from demo data.
    if (workspace?.get() !== 'demo') {
      for (const e of entries) {
        if (e.draft && e.narrative.trim() !== e.draft.trim()) phrasebook.addCorrection({ draft: e.draft, final: e.narrative, matter: matterKey(e.matter) });
      }
      coder.add(
        entries
          .filter((e) => e.task || e.activity)
          .map((e) => ({ at: Date.now(), source: 'export', matter: matterKey(e.matter), code_set: e.matter.code_set, narrative: e.narrative, task: e.task || undefined, activity: e.activity || undefined })),
      );
    }
    return { filename, savedTo, count: entries.length, body };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(publicDir, url.pathname, res);
      guardOrigin(req);

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(fullState())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        const result = await handler(body, url.searchParams, m.slice(1));
        return send(res, 200, result ?? { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message, ...(e.warnings ? { warnings: e.warnings } : {}) });
    }
  });

  server.on('close', () => {
    clearInterval(ticker);
    for (const res of clients) res.end();
  });
  return server;
}

/** Open the OS page where microphone access is granted. Opens a settings pane; changes nothing. */
function openMicrophoneSettings() {
  const target =
    process.platform === 'darwin'
      ? ['open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', 'ms-settings:privacy-microphone']]
        : null;
  if (!target) throw httpError(501, 'Open your system privacy settings to allow microphone access');
  spawn(target[0], target[1], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

function dateParam(q, store) {
  const date = q.get('date') || store.today();
  if (!isDate(date)) throw httpError(400, 'date must be YYYY-MM-DD');
  return date;
}

// Block cross-site requests from web pages: only our own page (or non-browser
// clients like the Stream Deck plugin, which send no Origin) may call the API.
function guardOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  if (origin !== `http://${host}`) throw httpError(403, 'Cross-origin request blocked');
}

async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] ?? '')) {
    // Requiring JSON forces a CORS preflight for browser requests, which we never approve.
    throw httpError(415, 'Content-Type must be application/json');
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, 'Body too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(publicDir, pathname, res) {
  const root = path.resolve(publicDir);
  const file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root + path.sep) && file !== root || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
