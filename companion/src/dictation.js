import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local dictation: record from the system default input with sox, transcribe
// with whisper.cpp. Audio never leaves the machine and is deleted afterward.

const MAX_MS = 5 * 60_000;

export class Dictation extends EventEmitter {
  constructor({ getConfig, onText, spawnImpl = spawn }) {
    super();
    this.getConfig = getConfig;
    this.onText = onText; // (text, context) => void
    this.spawn = spawnImpl;
    this.status = 'idle'; // idle | recording | transcribing
    this.error = null;
    this.startedAt = null;
    this.proc = null;
  }

  snapshot() {
    return { status: this.status, error: this.error, started_at: this.startedAt };
  }

  #set(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('change');
  }

  /** context is passed back to onText (e.g. which matter was running at start). */
  start(context = {}) {
    if (this.status !== 'idle') throw Object.assign(new Error(`Dictation is ${this.status}`), { status: 409 });
    const cfg = this.getConfig().dictation;
    if (!fs.existsSync(cfg.model)) {
      throw Object.assign(new Error(`Whisper model not found at ${cfg.model}. See README → Dictation.`), { status: 503 });
    }
    this.file = path.join(os.tmpdir(), `deck-time-${process.pid}-${Date.now()}.wav`);
    this.context = context;
    // 16 kHz mono 16-bit is what whisper wants; `rec` uses the system default input.
    const env = cfg.device ? { ...process.env, AUDIODEV: cfg.device } : process.env;
    this.proc = this.spawn(cfg.recorder, ['-q', '-c', '1', '-r', '16000', '-b', '16', this.file], { env });
    this.proc.on('error', (e) => {
      this.proc = null;
      this.#set('idle', e.code === 'ENOENT' ? `"${cfg.recorder}" not found. Install sox: brew install sox` : e.message);
    });
    this.startedAt = Date.now();
    this.timeout = setTimeout(() => this.stop().catch(() => {}), MAX_MS);
    this.timeout.unref();
    this.#set('recording');
  }

  async stop() {
    if (this.status !== 'recording' || !this.proc) return null;
    clearTimeout(this.timeout);
    const proc = this.proc;
    this.proc = null;
    this.#set('transcribing');
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGINT'); // sox finalizes the WAV header on SIGINT
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);

    try {
      const text = await this.transcribe(this.file);
      if (text) this.onText(text, this.context);
      this.#set('idle', text ? null : 'Heard nothing');
      return text;
    } catch (e) {
      this.#set('idle', e.message);
      throw Object.assign(e, { status: 500 });
    } finally {
      fs.rm(this.file, { force: true }, () => {});
    }
  }

  async toggle(context) {
    if (this.status === 'recording') return { text: await this.stop() };
    this.start(context);
    return { recording: true };
  }

  transcribe(file) {
    const cfg = this.getConfig().dictation;
    const args = ['-m', cfg.model, '-f', file, '-l', 'en', '-nt', '-np'];
    if (this.context?.prompt) args.push('--prompt', this.context.prompt);
    return new Promise((resolve, reject) => {
      const p = this.spawn(cfg.whisper, args);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) =>
        reject(new Error(e.code === 'ENOENT' ? `"${cfg.whisper}" not found. Install: brew install whisper-cpp` : e.message)),
      );
      p.on('exit', (code) => (code === 0 ? resolve(cleanTranscript(out)) : reject(new Error(`whisper failed: ${err.slice(-300)}`))));
    });
  }
}

export function cleanTranscript(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()) // stray timestamps
    .filter((l) => l && !/^\[?(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]?$/i.test(l) && !/^\(.*\)$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
