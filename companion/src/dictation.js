import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local dictation: record from the system default input with sox, transcribe
// with whisper.cpp. Audio never leaves the machine and is deleted afterward.

const MAX_MS = 5 * 60_000;
const SILENCE_PEAK = 0.003; // about -50 dBFS: below this, nothing was captured
export const NO_SOUND =
  'No sound was recorded. Allow microphone access for Stream Deck (System Settings → Privacy & Security → Microphone) and check the input device in Sound settings.';

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
    return { status: this.status, error: this.error, started_at: this.startedAt, last: this.last ?? null };
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
        reject(new Error(e.code === 'ENOENT' ? `"${cfg.whisper}" not found. Install: brew install whisper-cpp` : e.message)),
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
