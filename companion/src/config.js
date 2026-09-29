import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// All personal data (DB, config, exports) lives outside the repo.
export const HOME = process.env.DECK_TIME_HOME || path.join(os.homedir(), '.deck-time');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const DB_PATH = path.join(HOME, 'deck-time.db');
export const EXPORT_DIR = path.join(HOME, 'exports');

const brew = (bin) => (fs.existsSync(`/opt/homebrew/bin/${bin}`) ? `/opt/homebrew/bin/${bin}` : bin);

export const DEFAULTS = {
  port: 7331,
  dictation: {
    recorder: brew('rec'), // sox; records from the macOS default input
    whisper: brew('whisper-cli'), // whisper.cpp
    model: path.join(HOME, 'models', 'ggml-small.en.bin'),
    device: '', // blank = system default input (set in System Settings → Sound)
  },
  timekeeper: {
    id: '',
    name: '',
  },
  rounding: {
    increment: 0.1, // hours
    mode: 'up', // 'up' | 'nearest'
    minimum: 0.1,
  },
  ai: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'gemma3:12b',
    // House style the model should follow. Edit freely in Settings.
    styleGuide: [
      'Write in the past tense, starting each task with a verb (e.g., "Reviewed", "Drafted", "Conferred").',
      'Separate distinct tasks with semicolons.',
      'Be specific about the document or subject, but never invent facts not in the notes.',
      'Do not use the words "work on", "attention to", or "various".',
      'Do not include hours or timekeeper names.',
    ].join('\n'),
    // Few-shot examples: { notes, narrative }
    examples: [
      {
        notes: 'call w/ opp counsel re NDA markup; revised draft',
        narrative:
          'Telephone conference with opposing counsel regarding comments to non-disclosure agreement; revised non-disclosure agreement to reflect same.',
      },
    ],
  },
  tim: {
    // Constant fields copied verbatim from a real Intapp Time export.
    // Re-learn from your own export with: npm run tim:learn -- path/to/file.TIM
    defaults: {
      billed: 'N',
      billing: 'N',
      closed: 'N',
      co: 'N',
      createdintimesaver: 'N',
      del: 'N',
      ex: 'N',
      f: 'TIME',
      originapplication: 'DTE Axiom',
      re: 'N',
      releasable: 'Y',
      st: 'Ready to be released',
      u1: '007',
      unconver: 'N',
      version: '9.14.43.829',
    },
    ssPrefix: '888888',
  },
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true });
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
  }
  const cfg = deepMerge(DEFAULTS, user);
  // Learned .TIM defaults replace ours wholesale (keys may have been removed).
  if (user.tim?.defaults) cfg.tim.defaults = user.tim.defaults;
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
