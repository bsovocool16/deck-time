// node:fs for the page. The data folder is held in memory, loaded from disk at
// startup (see preload), so the companion's synchronous reads and writes work
// unchanged; every write is queued to the real file in order. Paths outside
// the data folder (whisper, sox, models) answer existsSync from a cache that
// refreshes itself in the background.
import { rt } from './runtime.js';

// Held on the runtime object so the startup copy of this module (which loads
// the folder before the companion's modules run) and the companion's copy share it.
const S = (rt.fsState ??= { files: new Map(), dirs: new Set(), known: new Map(), pending: new Set(), externalDirs: new Set(), queue: Promise.resolve() });
const { files, dirs, known, pending, externalDirs } = S; // files: path -> string | Uint8Array | EXTERNAL
const EXTERNAL = (rt.EXTERNAL ??= Symbol('on disk, not loaded'));

export const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

function addDirs(p) {
  for (let d = parent(p); d && d !== '/' && !dirs.has(d); d = parent(d)) dirs.add(d);
}

/** Queue a disk operation; writes land in the order they were made. */
function persist(op) {
  const d = rt.disk;
  if (!d) return;
  S.queue = S.queue.then(() => op(d)).catch((e) => rt.onPersistError(e));
}
/** Resolves once every queued write is on disk (before a child process reads a file). */
export const flushed = () => S.queue;

/** Load the data folder into memory. Big files (models) are only noted as present. */
export async function preload(root, { skip = ['models', 'whisper'], maxBytes = 50_000_000 } = {}) {
  const d = rt.disk;
  root = norm(root);
  dirs.add(root);
  if (!d || !(await d.fs.exists(root))) return;
  async function walk(dir, depth) {
    for (const e of await d.fs.readdir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        dirs.add(p);
        if (depth < 4 && !(dir === root && skip.includes(e.name))) await walk(p, depth + 1);
        else externalDirs.add(p);
      } else if (e.isFile) {
        const st = await d.fs.stat(p);
        if (st.size > maxBytes) files.set(p, EXTERNAL);
        else if (/\.(db|wav|bin)$/.test(e.name)) files.set(p, await d.fs.readFile(p));
        else files.set(p, await d.fs.readFile(p, 'utf8'));
      }
    }
  }
  await walk(root, 0);
}

/** Learn whether outside paths exist (call at startup for anything checked while modules load). */
export async function probe(paths) {
  const d = rt.disk;
  await Promise.all(paths.map(async (p) => known.set(norm(p), d ? await d.fs.exists(p).catch(() => false) : false)));
}

function inMemory(p) {
  return files.has(p) || dirs.has(p);
}
function underData(p) {
  const home = rt.env.DECK_TIME_HOME && norm(rt.env.DECK_TIME_HOME);
  return home && (p === home || p.startsWith(home + '/'));
}

function existsSync(path) {
  const p = norm(path);
  if (inMemory(p)) return true;
  if (underData(p) && ![...externalDirs].some((d) => p.startsWith(d + '/'))) return false;
  if (rt.disk && !pending.has(p)) {
    // look (again) in the background, so an install shows up without a restart
    pending.add(p);
    rt.disk.fs.exists(path).then((x) => known.set(p, x)).catch(() => known.set(p, false)).finally(() => pending.delete(p));
  }
  return known.get(p) === true;
}

function readFileSync(path, enc) {
  const p = norm(path);
  const v = files.get(p);
  if (v === undefined || v === EXTERNAL) throw enoent(path);
  const encoding = typeof enc === 'string' ? enc : enc?.encoding;
  if (encoding) return typeof v === 'string' ? v : new TextDecoder().decode(v);
  return typeof v === 'string' ? new TextEncoder().encode(v) : v;
}

const toDisk = (data) => (typeof data === 'string' ? data : data instanceof Uint8Array ? data : String(data));

function writeFileSync(path, data) {
  const p = norm(path);
  const v = toDisk(data);
  files.set(p, typeof v === 'string' ? v : new Uint8Array(v));
  addDirs(p);
  persist(async (d) => {
    await d.fs.mkdir(parent(path.replace(/\\/g, '/')), { recursive: true }).catch(() => {});
    await d.fs.writeFile(path, v, typeof v === 'string' ? 'utf8' : undefined);
  });
}

function appendFileSync(path, data) {
  const p = norm(path);
  const prev = files.get(p);
  const add = String(data);
  files.set(p, (typeof prev === 'string' ? prev : prev instanceof Uint8Array ? new TextDecoder().decode(prev) : '') + add);
  addDirs(p);
  persist(async (d) => {
    await d.fs.mkdir(parent(path.replace(/\\/g, '/')), { recursive: true }).catch(() => {});
    await d.fs.appendFile(path, add, 'utf8');
  });
}

function mkdirSync(path) {
  const p = norm(path);
  dirs.add(p);
  addDirs(p + '/x');
  persist((d) => d.fs.mkdir(path, { recursive: true }).catch(() => {}));
}

function rmSync(path, opts = {}) {
  const p = norm(path);
  const had = files.delete(p) || dirs.delete(p);
  known.delete(p);
  if (!had && !opts.force) throw enoent(path);
  persist(async (d) => {
    if (await d.fs.exists(path)) await d.fs.rm(path, { force: true, recursive: !!opts.recursive });
  });
}

function rm(path, opts, cb) {
  if (typeof opts === 'function') [cb, opts] = [opts, {}];
  try {
    rmSync(path, { ...opts, force: true });
  } catch {}
  flushed().then(() => cb?.(null));
}

function statSync(path) {
  const p = norm(path);
  if (dirs.has(p)) return { isDirectory: () => true, isFile: () => false, size: 0 };
  const v = files.get(p);
  if (v === undefined) throw enoent(path);
  return { isDirectory: () => false, isFile: () => true, size: v === EXTERNAL ? 0 : v.length };
}

function readdirSync(path) {
  const p = norm(path);
  const names = new Set();
  for (const k of [...files.keys(), ...dirs]) if (parent(norm(k)) === p) names.add(norm(k).slice(p.length + 1));
  return [...names].filter(Boolean);
}

/** Write bytes straight to disk, bypassing memory (dictation recordings). */
export function writeThrough(path, bytes) {
  persist(async (d) => d.fs.writeFile(path, bytes));
  return flushed();
}

const fs = {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, rm, statSync, readdirSync,
  createReadStream() {
    throw new Error('not available in the app');
  },
  promises: {},
};
export default fs;
export { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, rm, statSync, readdirSync };
