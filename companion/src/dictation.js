import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local dictation, transcribed with whisper.cpp. Audio never leaves the
// machine and is deleted afterward. Two ways to capture it:
//
// - browser (default, macOS and Windows): the open deck-time window records
//   with the browser's microphone permission and sends the audio back when you
//   stop. Works no matter which app started the server (Stream Deck included).
// - sox: the server records from the system default input itself.

const MAX_MS = 5 * 60_000;
const AUDIO_WAIT_MS = 20_000; // how long to wait for the window's recording after stop
const SILENCE_PEAK = 0.003; // about -50 dBFS: below this, nothing was captured
export const NO_SOUND =
  'No sound was recorded. Allow microphone access for Stream Deck (System Settings → Privacy & Security → Microphone) and check the input device in Sound settings.';
export const NO_SOUND_BROWSER =
  'No sound was recorded. Check that this site may use the microphone (the icon in the address bar) and that the right input device is selected and not muted.';
export const NO_RECORDER = 'Open deck-time in your browser to dictate; it records from that window.';

export class Dictation extends EventEmitter {
  constructor({ getConfig, onText, spawnImpl = spawn, recorders = () => 0 }) {
    super();
    this.getConfig = getConfig;
    this.onText = onText; // (text, context) => void
    this.spawn = spawnImpl;
    this.recorders = recorders; // how many open windows can record (browser capture); the server sets this
    this.status = 'idle'; // idle | recording | transcribing
    this.error = null;
    this.startedAt = null;
    this.proc = null;
  }

  /** 'browser' (the open window records) or 'sox' (the server records). */
  get capture() {
    return this.getConfig().dictation?.capture === 'browser' ? 'browser' : 'sox'; // the shipped default is 'browser'
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      started_at: this.startedAt,
      last: this.last ?? null,
      capture: this.capture,
      capture_id: this.captureId ?? null,
      missing: this.missing(), // what's not installed yet, or null when dictation can work
    };
  }

  /** Whisper and its model are what dictation needs on this computer (plus sox for sox capture). Cached briefly. */
  missing() {
    if (this.missingCache && Date.now() - this.missingCache.at < 10_000) return this.missingCache.value;
    const cfg = this.getConfig().dictation;
    let value = null;
    if (!onPath(cfg.whisper)) value = 'whisper.cpp is not installed';
    else if (!fs.existsSync(cfg.model)) value = `the Whisper model isn't at ${cfg.model}`;
    else if (this.capture === 'sox' && !onPath(cfg.recorder)) value = 'sox is not installed';
    this.missingCache = { at: Date.now(), value };
    return value;
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
    if (this.capture === 'browser') {
      if (!this.recorders()) throw Object.assign(new Error(NO_RECORDER), { status: 409 });
      this.captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      this.startedAt = Date.now();
      this.timeout = setTimeout(() => this.stop().catch(() => {}), MAX_MS);
      this.timeout.unref();
      this.#set('recording');
      this.emit('capture', { action: 'start', id: this.captureId });
      return;
    }
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
    if (this.status === 'recording' && this.capture === 'browser' && this.captureId) return this.#stopBrowser();
    if (this.status !== 'recording' || !this.proc) return null;
    clearTimeout(this.timeout);
    const proc = this.proc;
    this.proc = null;
    this.#set('transcribing');
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGINT'); // sox finalizes the WAV header on SIGINT
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);

    const padded = this.file.replace(/\.wav$/, '-pad.wav');
    try {
      const { sox } = this.getConfig().dictation;
      // A silent file usually means the microphone isn't reaching us (permission or input device).
      const peak = await this.peakLevel(this.file);
      if (peak !== null && peak < SILENCE_PEAK) {
        this.#set('idle', NO_SOUND);
        this.emit('nosound');
        return '';
      }
      // Leading silence stops whisper from dropping words spoken right at key-down.
      const audio = (await this.#run(sox, [this.file, padded, 'pad', '0.5', '0.3'])) ? padded : this.file;
      const text = dropPromptEcho(await this.transcribe(audio), this.context?.echoes ?? this.context?.prompt);
      if (text) {
        this.onText(text, this.context);
        this.last = { text, matter_id: this.context?.matterId ?? null, at: Date.now() };
      }
      this.#set('idle', text ? null : 'Heard nothing');
      return text;
    } catch (e) {
      this.#set('idle', e.message);
      throw Object.assign(e, { status: 500 });
    } finally {
      for (const f of [this.file, padded]) fs.rm(f, { force: true }, () => {});
    }
  }

  /** Browser capture: ask the window for its recording, then transcribe it. */
  async #stopBrowser() {
    clearTimeout(this.timeout);
    const id = this.captureId;
    this.#set('transcribing');
    const audio = new Promise((resolve) => {
      this.pending = { id, resolve };
      setTimeout(() => resolve({ error: 'The deck-time window didn\'t send its recording. Is it still open?' }), AUDIO_WAIT_MS).unref();
    });
    this.emit('capture', { action: 'stop', id });
    const got = await audio;
    this.pending = null;
    this.captureId = null;
    if (got.error) {
      this.#set('idle', got.error);
      return '';
    }
    try {
      fs.writeFileSync(this.file, got.wav);
      const peak = wavPeak(got.wav);
      if (peak !== null && peak < SILENCE_PEAK) {
        this.#set('idle', NO_SOUND_BROWSER);
        this.emit('nosound');
        return '';
      }
      // The window already padded the start and end with a little silence.
      const text = dropPromptEcho(await this.transcribe(this.file), this.context?.echoes ?? this.context?.prompt);
      if (text) {
        this.onText(text, this.context);
        this.last = { text, matter_id: this.context?.matterId ?? null, at: Date.now() };
      }
      this.#set('idle', text ? null : 'Heard nothing');
      return text;
    } catch (e) {
      this.#set('idle', e.message);
      throw Object.assign(e, { status: 500 });
    } finally {
      fs.rm(this.file, { force: true }, () => {});
    }
  }

  /** The window's recording (16 kHz mono WAV) for capture `id`. */
  receiveAudio(id, wav) {
    if (!this.pending || this.pending.id !== id) throw Object.assign(new Error('No dictation is waiting for this recording'), { status: 409 });
    if (!Buffer.isBuffer(wav) || wav.length < 44) throw Object.assign(new Error('Not a recording'), { status: 400 });
    this.pending.resolve({ wav });
    return { ok: true };
  }

  /** The window couldn't record (e.g. microphone blocked). */
  fail(id, message) {
    const text = String(message || 'The microphone could not be used').slice(0, 300);
    if (this.pending?.id === id) this.pending.resolve({ error: text });
    else if (this.status === 'recording' && this.captureId === id) {
      clearTimeout(this.timeout);
      this.captureId = null;
      this.#set('idle', text);
    }
    return { ok: true };
  }

  async toggle(context) {
    if (this.status === 'recording') return { text: await this.stop() };
    this.start(context);
    return { recording: true };
  }

  /**
   * Record a few seconds and report whether any sound arrived. On macOS the
   * first recording is also what makes the system ask for microphone access.
   */
  async testMic(seconds = 3) {
    if (this.status !== 'idle') throw Object.assign(new Error(`Dictation is ${this.status}`), { status: 409 });
    const cfg = this.getConfig().dictation;
    const file = path.join(os.tmpdir(), `deck-time-mictest-${process.pid}-${Date.now()}.wav`);
    const env = cfg.device ? { ...process.env, AUDIODEV: cfg.device } : process.env;
    this.#set('testing');
    try {
      const result = await new Promise((resolve) => {
        const p = this.spawn(cfg.recorder, ['-q', '-c', '1', '-r', '16000', '-b', '16', file, 'trim', '0', String(seconds)], { env });
        p.on('error', (e) => resolve(e));
        p.on('exit', (code) => resolve(code === 0 ? true : new Error(`The recorder stopped unexpectedly (code ${code})`)));
      });
      if (result !== true) {
        throw Object.assign(result.code === 'ENOENT' ? new Error(`"${cfg.recorder}" not found. Install sox: brew install sox`) : result, { status: 500 });
      }
      const peak = await this.peakLevel(file);
      return { peak, heard: peak !== null && peak >= SILENCE_PEAK };
    } finally {
      fs.rm(file, { force: true }, () => {});
      this.#set('idle');
    }
  }

  /** Loudest sample in the recording (0..1), or null if sox can't tell us. */
  peakLevel(file) {
    return new Promise((resolve) => {
      const p = this.spawn(this.getConfig().dictation.sox, [file, '-n', 'stat']);
      let err = '';
      p.stderr?.on('data', (d) => (err += d));
      p.on('error', () => resolve(null));
      p.on('exit', () => {
        const m = err.match(/Maximum amplitude:\s*(-?[\d.]+)/);
        resolve(m ? Math.abs(Number(m[1])) : null);
      });
    });
  }

  /** Resolves true on exit code 0, false on any failure. */
  #run(cmd, args) {
    return new Promise((resolve) => {
      const p = this.spawn(cmd, args);
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  async transcribe(file) {
    const prompt = this.context?.prompt;
    try {
      return await this.#whisper(file, prompt);
    } catch (e) {
      // The vocabulary hint is the only part of the command that varies; if
      // whisper rejected its arguments, retry once without it.
      if (!prompt || !e.whisperUsage) throw e;
      console.error(`[deck-time] whisper rejected the prompt; retrying without it. ${e.message}`);
      return this.#whisper(file, null);
    }
  }

  #whisper(file, prompt) {
    const cfg = this.getConfig().dictation;
    const args = ['-m', cfg.model, '-f', file, '-l', 'en', '-nt', '-np'];
    if (prompt) args.push('--prompt', prompt);
    return new Promise((resolve, reject) => {
      const p = this.spawn(cfg.whisper, args);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) =>
        reject(new Error(e.code === 'ENOENT' ? `"${cfg.whisper}" not found. See README → Dictation to install whisper.cpp.` : e.message)),
      );
      p.on('exit', (code) => {
        if (code === 0) return resolve(cleanTranscript(out));
        // Full details go to the console (the Terminal running deck-time); the message keeps whisper's own reason.
        console.error(`[deck-time] whisper exited with code ${code}\nargs: ${JSON.stringify(args)}\n${err}`);
        reject(Object.assign(new Error(`Transcription failed: ${whisperReason(err, code)}`), { whisperUsage: /usage:/i.test(err) }));
      });
    });
  }
}

/** Loudest sample (0..1) in a 16-bit PCM WAV, or null if it isn't one. */
export function wavPeak(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      let max = 0;
      const end = Math.min(buf.length - 1, off + 8 + size);
      for (let i = off + 8; i < end; i += 2) max = Math.max(max, Math.abs(buf.readInt16LE(i)));
      return max / 32768;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Is this command runnable: an existing path, or a name found on PATH (with .exe/.cmd on Windows)? */
export function onPath(cmd) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && exts.some((x) => fs.existsSync(path.join(dir, cmd + x))));
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

/**
 * On silent or near-silent audio, Whisper tends to repeat its prompt back
 * ("Legal billing notes for Acme."). Treat a transcript that's only the
 * prompt's opening line, or only the matter name, as nothing heard. `echoes`
 * is that short list (not the vocabulary, so a real "disclosure schedules"
 * survives); a plain prompt string is accepted too.
 */
export function dropPromptEcho(text, echoes) {
  if (!text || !echoes) return text;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(text);
  const list = (Array.isArray(echoes) ? echoes : [echoes, echoes.replace(/^legal billing notes for /i, '')]).map(norm).filter(Boolean);
  return list.some((e) => t === e || (t.length > 0 && e.includes(t))) ? '' : text;
}

/** Words lawyers dictate that Whisper tends to mishear without a hint. Editable in Settings. */
export const DEFAULT_VOCABULARY = [
  'seller', 'buyer', 'disclosure schedules', 'merger agreement', 'purchase agreement', 'stock purchase agreement',
  'reps and warranties', 'indemnification', 'escrow', 'earnout', 'closing conditions', 'MAC', 'material adverse change',
  'termination fee', 'fairness opinion', 'special committee', 'board minutes', 'resolutions', 'proxy statement',
  '8-K', '10-K', '10-Q', 'SEC', 'Delaware', 'fiduciary duties', 'credit agreement', 'covenants', 'term sheet', 'NDA',
  'due diligence', 'interrogatories', 'requests for production', 'deposition', 'privilege log', 'meet and confer',
  'motion to dismiss', 'summary judgment', 'opposing counsel', 'general counsel', 'CFO', 'redline', 'markup',
  'issues list', 'signature pages', 'closing checklist', 'IP', 'licensing',
];

/**
 * The hint Whisper gets: what the note is about, then matter names and legal
 * vocabulary so domain words come out right. Kept short (Whisper reads only
 * the last ~220 tokens of a prompt).
 */
export function dictationPrompt(matter, { matters = [], vocabulary, extra = [] } = {}) {
  const head = `Legal billing notes for ${matter.name}.`;
  const custom = (typeof vocabulary === 'string' ? vocabulary.split(/[,\n]/) : vocabulary ?? []).map((s) => String(s).trim()).filter(Boolean);
  // Matter names and your learned phrasing first (they matter most), then the general legal list.
  const terms = [...new Set([...matters.map((m) => m.name), ...extra, ...(custom.length ? custom : DEFAULT_VOCABULARY)].map((s) => String(s).trim()).filter(Boolean))];
  let prompt = `${head} Terms: ${terms.join(', ')}.`;
  while (prompt.length > 900 && terms.length) {
    terms.pop();
    prompt = `${head} Terms: ${terms.join(', ')}.`;
  }
  return { prompt, echoes: [head, matter.name] };
}

/** The useful line from whisper's error output (it often appends its whole help text). */
export function whisperReason(stderr, code) {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^error\b|error:/i.test(l)) ?? lines.find((l) => !/^usage:|^\s*-/i.test(l)) ?? `exit code ${code}`;
}
