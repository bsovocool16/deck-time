import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiStatus, draftNarrative, suggestCodes } from './ai.js';
import { codesFor } from './codes.js';
import { Dictation } from './dictation.js';
import { DB_PATH, EXPORT_DIR, loadConfig, saveConfig, deepMerge } from './config.js';
import { exportable, learnFromTim, toCsv, toTim, validateForTim } from './export.js';
import { Store, httpError } from './store.js';
import { isDate, localDate } from './time.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createServer({ store, getConfig, setConfig, fetchImpl = fetch, exportDir = EXPORT_DIR, dictation = null }) {
  const clients = new Set();
  store.on('change', () => broadcast());
  dictation?.on('change', () => broadcast());
  const fullState = () => ({ ...store.state(), dictation: dictation?.snapshot() ?? null });
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
      dictation.start({ matterId: matter.id, prompt: `Legal billing notes for ${matter.name}.` });
      return { recording: true };
    }],
    ['GET', /^\/api\/matters$/, (_, q) => store.listMatters({ includeArchived: q.get('all') === '1' })],
    ['POST', /^\/api\/matters$/, (b) => store.createMatter(b)],
    ['PATCH', /^\/api\/matters\/(\d+)$/, (b, _, [id]) => store.updateMatter(+id, b)],
    ['POST', /^\/api\/timer\/toggle$/, (b) => store.toggle(+b.matter_id)],
    ['POST', /^\/api\/timer\/stop$/, () => store.stop()],
    ['POST', /^\/api\/timer\/note$/, (b) => store.addNote(String(b.text ?? ''), b.matter_id ? +b.matter_id : undefined)],
    ['GET', /^\/api\/day$/, (_, q) => store.day(dateParam(q))],
    ['GET', /^\/api\/segments$/, (_, q) => store.segmentsForDay(dateParam(q))],
    ['POST', /^\/api\/segments$/, (b) => store.addSegment(b)],
    ['PATCH', /^\/api\/segments\/(\d+)$/, (b, _, [id]) => store.updateSegment(+id, b)],
    ['DELETE', /^\/api\/segments\/(\d+)$/, (_, __, [id]) => store.deleteSegment(+id)],
    ['PATCH', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)$/, (b, _, [date, id]) => store.updateEntry(date, +id, b)],
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/narrate$/, async (_, __, [date, id]) => {
      const matterId = +id;
      const entry = store.day(date).entries.find((e) => e.matter_id === matterId) ?? store.getEntry(date, matterId);
      const narrative = await draftNarrative({
        config: getConfig(),
        matter: store.getMatter(matterId),
        notes: entry.notes,
        hours: entry.hours,
        recent: store.recentNarratives(matterId),
        fetchImpl,
      });
      const saved = store.updateEntry(date, matterId, { narrative });
      // Fill codes too, unless the user already chose them for this entry.
      const codes = codesFor(store.getMatter(matterId), getConfig());
      if (!codes || (saved.task_code && saved.activity_code)) return saved;
      try {
        return store.updateEntry(date, matterId, await suggestCodes({ config: getConfig(), narrative, codes, fetchImpl }));
      } catch (e) {
        console.warn(`code suggestion failed: ${e.message}`);
        return saved;
      }
    }],
    ['POST', /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/codes$/, async (_, __, [date, id]) => {
      const matterId = +id;
      const codes = codesFor(store.getMatter(matterId), getConfig());
      if (!codes) throw httpError(400, 'This matter does not use task/activity codes');
      const { narrative, notes } = store.getEntry(date, matterId);
      const picked = await suggestCodes({ config: getConfig(), narrative: narrative || notes, codes, fetchImpl });
      return store.updateEntry(date, matterId, picked);
    }],
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

  function exportDay({ date, format = 'tim', includeExported = false, markExported = true }) {
    if (!isDate(date)) throw httpError(400, 'date must be YYYY-MM-DD');
    const config = getConfig();
    const entries = exportable(store.day(date).entries, { includeExported });
    if (!entries.length) throw httpError(400, 'Nothing to export for that day');
    const problems = format === 'csv' ? entries.filter((e) => !e.narrative.trim()).map((e) => `${e.matter.name}: missing narrative`) : validateForTim(entries, config);
    if (problems.length) throw httpError(400, `Can't export yet: ${problems.join('; ')}`);
    const body = format === 'csv' ? toCsv(entries) : toTim(entries, config);
    const filename = `deck-time-${date}.${format === 'csv' ? 'csv' : 'tim'}`;
    fs.mkdirSync(exportDir, { recursive: true });
    const savedTo = path.join(exportDir, filename);
    fs.writeFileSync(savedTo, body);
    if (markExported) for (const e of entries) store.updateEntry(date, e.matter_id, { status: 'exported' });
    return { filename, savedTo, count: entries.length, body };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
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
      send(res, status, { error: e.message });
    }
  });

  server.on('close', () => {
    clearInterval(ticker);
    for (const res of clients) res.end();
  });
  return server;
}

function dateParam(q) {
  const date = q.get('date') || localDate();
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

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- entry point ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config = loadConfig();
  const store = new Store(DB_PATH, () => config);
  const dictation = new Dictation({ getConfig: () => config, onText: (text, ctx) => store.addNote(text, ctx.matterId) });
  const server = createServer({
    store,
    dictation,
    getConfig: () => config,
    setConfig: (next) => (config = saveConfig(next)),
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`deck-time running at http://127.0.0.1:${config.port}`);
    console.log(`data: ${DB_PATH}`);
  });
  const shutdown = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
