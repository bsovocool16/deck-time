// Small stand-ins: node:os, node:url, node:crypto, and the companion's
// window.js (the Review key raises this app's own window).
import { rt } from './runtime.js';

export const os = {
  homedir: () => rt.homedir,
  tmpdir: () => rt.tmpdir,
  platform: () => rt.platform,
  hostname: () => 'localhost',
  EOL: '\n',
};

export const url = {
  fileURLToPath: (u) => String(u || 'file:///app/companion/src/index.js').replace(/^file:\/\//, ''),
  pathToFileURL: (p) => new URL(`file://${p}`),
};

export const crypto = {
  randomUUID: () =>
    globalThis.crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)),
};

export const windowJs = {
  browserOf: () => 'deck-time app',
  /** Review key: bring this window forward. */
  raise: async () => {
    await rt.showWindow?.();
    return true;
  },
};

/** fetch for the companion: talks to local services (Ollama) through curl, since the page can't reach localhost itself. */
export async function localFetch(input, init = {}) {
  const target = String(input);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target)) return globalThis.fetch(input, init);
  const cp = rt.disk?.childProcess;
  if (!cp) throw new TypeError('fetch failed: local services need the installed app');
  const win = rt.platform === 'win32';
  const q = (s) => (win ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
  const method = init.method || 'GET';
  const parts = [win ? 'curl.exe' : 'curl', '-s', '-S', '-X', method, '-w', q('\n%{http_code}'), '--max-time', '180'];
  for (const [k, v] of Object.entries(init.headers || {})) parts.push('-H', q(`${k}: ${v}`));
  if (init.body != null) parts.push('--data-binary', '@-');
  parts.push(q(target));
  const r = await cp.exec(parts.join(' '), { input: init.body != null ? String(init.body) : undefined, timeout: 190_000 });
  if (r.code !== 0 && !r.stdout) throw new TypeError(`fetch failed: ${r.stderr.trim() || 'connection refused'}`);
  const cut = r.stdout.lastIndexOf('\n');
  const status = +r.stdout.slice(cut + 1) || 0;
  if (!status) throw new TypeError('fetch failed: connection refused');
  const text = r.stdout.slice(0, cut);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

export const processShim = {
  get platform() {
    return rt.platform;
  },
  get env() {
    return rt.env;
  },
  pid: 1,
  argv: [],
  version: 'v22.13.0',
  versions: { node: '22.13.0' },
  cwd: () => rt.homedir,
  on() {},
  once() {},
  off() {},
  emitWarning() {},
  exit() {},
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
};
