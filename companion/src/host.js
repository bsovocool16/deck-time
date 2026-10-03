import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome, loadConfig, pathsFor, saveConfig } from './config.js';
import { CodeMemory } from './coder.js';
import { Phrasebook } from './phrasebook.js';
import { seedDemo } from './demo-seed.js';
import { Dictation } from './dictation.js';
import { createServer } from './server.js';
import { Store } from './store.js';
import { Teacher } from './teacher.js';
import { DEMO_CORRECTIONS } from './demo-seed.js';

export const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * A store handle that can be pointed at a different database (real vs demo)
 * while the server keeps one reference and one 'change' subscription.
 */
export function switchableStore(initial) {
  const hub = new EventEmitter();
  let current = null;
  const forward = () => hub.emit('change');
  const use = (next) => {
    current?.off('change', forward);
    current = next;
    current.on('change', forward);
    hub.emit('change');
  };
  use(initial);
  return new Proxy(hub, {
    get(target, key) {
      if (key === 'use') return use;
      if (key === 'current') return current;
      if (key in EventEmitter.prototype) return target[key].bind(target);
      const value = current[key];
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

/** A handle that always calls through to the current object (e.g. this workspace's phrasebook). */
function forward(current) {
  return new Proxy(
    {},
    {
      get(_, key) {
        const target = current();
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    },
  );
}

/**
 * Start the companion: config, stores, optional dictation, HTTP server.
 * Used by `npm start` (full edition) and by the Stream Deck plugin (office edition).
 */
export async function startCompanion({ home = defaultHome(), edition = 'full', publicDir = DEFAULT_PUBLIC_DIR, port, log = console.log } = {}) {
  const paths = pathsFor(home);
  let config = loadConfig(home, edition);
  const getConfig = () => config;
  const setConfig = (next) => (config = saveConfig(next, home));

  const stores = { real: null, demo: null };
  const open = (name) => {
    if (!stores[name]) {
      stores[name] = new Store(name === 'demo' ? paths.demoDb : paths.db, getConfig);
      if (name === 'demo') seedDemo(stores[name]);
    }
    return stores[name];
  };
  const workspaceName = () => (config.workspace === 'demo' ? 'demo' : 'real');
  const store = switchableStore(open(workspaceName()));

  const workspace = {
    get: workspaceName,
    set(name) {
      const next = name === 'demo' ? 'demo' : 'real';
      setConfig({ ...config, workspace: next });
      if (next === 'demo') seedDemo(open('demo')); // top up today's sample day
      store.use(open(next));
      return { workspace: next };
    },
    resetDemo() {
      stores.demo?.close();
      stores.demo = null;
      for (const f of [paths.demoDb, `${paths.demoDb}-wal`, `${paths.demoDb}-shm`, paths.demoCorrections, paths.demoTeacher]) fs.rmSync(f, { force: true });
      delete learning.demo; // fresh fictional edits, no taught rules
      if (workspaceName() === 'demo') store.use(open('demo'));
      return { workspace: workspaceName() };
    },
  };

  const dictation = config.features?.dictation
    ? new Dictation({ getConfig, onText: (text, ctx) => store.addNote(text, ctx.matterId, 'dictated', ctx.startedAt) })
    : null;

  const coder = new CodeMemory(paths.codeMemory);
  // Phrasebook + teacher per workspace, so demo day's fictional edits never teach your real drafter.
  const learning = {};
  const openLearning = (name) => {
    if (!learning[name]) {
      const demo = name === 'demo';
      if (demo && !fs.existsSync(paths.demoCorrections)) fs.writeFileSync(paths.demoCorrections, DEMO_CORRECTIONS.map((c) => JSON.stringify(c)).join('\n') + '\n');
      let teacher = null;
      const phrasebook = new Phrasebook({
        file: demo ? paths.demoCorrections : paths.corrections,
        custom: () => config.phrasebook,
        corpus: () => coder.examples,
        taught: () => teacher?.rules() ?? [],
      });
      teacher = new Teacher({ file: demo ? paths.demoTeacher : paths.teacher, phrasebook, getConfig });
      learning[name] = { phrasebook, teacher };
    }
    return learning[name];
  };
  const phrasebook = forward(() => openLearning(workspaceName()).phrasebook);
  const teacher = forward(() => openLearning(workspaceName()).teacher);
  const server = createServer({ store, getConfig, setConfig, dictation, publicDir, exportDir: paths.exports, workspace, coder, phrasebook, teacher });
  const listenPort = port ?? config.port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  log(`deck-time (${edition}) running at ${url}`);
  log(`data: ${home}`);

  return {
    url,
    server,
    store,
    close() {
      server.close();
      stores.real?.close();
      stores.demo?.close();
    },
  };
}
