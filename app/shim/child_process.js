// node:child_process for the page, on the desktop app's process API. A child
// starts only after pending file writes are on disk (whisper reads the
// recording the companion just wrote).
import { EventEmitter } from 'events';
import { rt } from './runtime.js';
import { flushed } from './fs.js';

const unavailable = (cmd) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });

export function spawn(cmd, args = [], opts = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.unref = () => child;
  let real = null;
  let killed = false;
  child.kill = (signal = 'SIGTERM') => {
    killed = true;
    real?.kill(signal === 'SIGINT' || signal === 'SIGKILL' || signal === 'SIGHUP' ? signal : 'SIGTERM').catch(() => {});
    return true;
  };
  (async () => {
    if (!rt.disk?.childProcess) throw unavailable(cmd);
    await flushed();
    if (killed) return child.emit('exit', null, 'SIGTERM');
    const env = opts.env ? { ...rt.env, ...opts.env } : undefined;
    real = rt.disk.childProcess.spawn(cmd, args.map(String), { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(env ? { env } : {}) });
    real.stdout.on('data', (d) => child.stdout.emit('data', d));
    real.stderr.on('data', (d) => child.stderr.emit('data', d));
    real.on('error', (e) => {
      const err = /ENOENT|not found/i.test(e.message) ? unavailable(cmd) : e;
      child.emit('error', err);
    });
    real.on('exit', (code, signal) => child.emit('exit', code, signal));
    real.on('close', (code, signal) => child.emit('close', code, signal));
  })().catch((e) => {
    setTimeout(() => {
      child.emit('error', e);
      child.emit('close', null, null);
    });
  });
  return child;
}

export function execFile(cmd, args = [], opts, cb) {
  if (typeof opts === 'function') [cb, opts] = [opts, {}];
  const p = spawn(cmd, args, opts);
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => cb?.(e, out, err));
  p.on('exit', (code) => cb?.(code ? Object.assign(new Error(err || `exit ${code}`), { code }) : null, out, err));
  return p;
}

export default { spawn, execFile };
