import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_CODES, TASK_SETS } from './codes.js';


// All personal data (DB, config, exports) lives outside the repo:
// ~/.deck-time on macOS, %APPDATA%\deck-time on Windows.
export function defaultHome() {
  if (process.env.DECK_TIME_HOME) return process.env.DECK_TIME_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'deck-time');
  return path.join(os.homedir(), '.deck-time');
}

export function pathsFor(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    db: path.join(home, 'deck-time.db'),
    demoDb: path.join(home, 'demo.db'), // fictional matters for showing people; never mixed with real data
    exports: path.join(home, 'exports'),
  };
}

export const HOME = defaultHome();

// Large models: the repo's (gitignored) models/ folder when running from source
// (e.g. on an external disk), otherwise the data folder's models/.
const REPO_MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models');
export const MODELS_DIR = fs.existsSync(REPO_MODELS) ? REPO_MODELS : path.join(HOME, 'models');
export const CONFIG_PATH = pathsFor(HOME).config;
export const DB_PATH = pathsFor(HOME).db;
export const EXPORT_DIR = pathsFor(HOME).exports;

const brew = (bin) => (fs.existsSync(`/opt/homebrew/bin/${bin}`) ? `/opt/homebrew/bin/${bin}` : bin);

export const DEFAULTS = {
  port: 7331,
  // Which optional parts are on. The office edition (inside the Stream Deck
  // plugin, for machines without a local model) turns both off.
  features: { ai: true, dictation: true },
  workspace: 'real', // 'real' | 'demo' (fictional matters for showing people)
  embedded: true, // let the Stream Deck plugin run deck-time itself; set false where you run `npm start` instead
  edition: 'office', // what the plugin runs: 'office' (no AI or dictation) or 'full' (needs Ollama, sox and Whisper on this machine)
  deck: { columns: 4, rows: 2 }, // Stream Deck Neo
  dictation: {
    recorder: brew('rec'), // sox; records from the macOS default input
    sox: brew('sox'),
    whisper: brew('whisper-cli'), // whisper.cpp
    model: path.join(MODELS_DIR, 'whisper', 'ggml-small.en.bin'),
    device: '', // blank = system default input (set in System Settings → Sound)
    vocabulary: '', // comma-separated words to help transcription; blank = built-in legal terms
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
  // UTBMS codes for matters that require them (Intapp u5 = task, u6 = activity).
  codes: {
    activities: ACTIVITY_CODES,
    taskSets: TASK_SETS,
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

export const EDITIONS = {
  full: {},
  office: { features: { ai: false, dictation: false } },
};

export function loadConfig(home = HOME, edition = 'full') {
  const { config: file } = pathsFor(home);
  const base = deepMerge(DEFAULTS, EDITIONS[edition] ?? {});
  fs.mkdirSync(home, { recursive: true });
  let user = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    fs.writeFileSync(file, JSON.stringify(base, null, 2));
  }
  const cfg = deepMerge(base, user);
  // Learned .TIM defaults replace ours wholesale (keys may have been removed).
  if (user.tim?.defaults) cfg.tim.defaults = user.tim.defaults;
  return cfg;
}

export function saveConfig(cfg, home = HOME) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(pathsFor(home).config, JSON.stringify(cfg, null, 2));
  return cfg;
}
