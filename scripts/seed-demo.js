// Seeds fictional matters (and today's sample morning) into ./data/demo for `npm run demo`.
// Never touches your real data folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, pathsFor } from '../companion/src/config.js';
import { seedDemo } from '../companion/src/demo-seed.js';
import { Store } from '../companion/src/store.js';

const home = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo');
fs.mkdirSync(home, { recursive: true });
const config = loadConfig(home);
const store = new Store(pathsFor(home).db, () => config);
seedDemo(store);
console.log(`demo data ready in ${home} (${store.listMatters().length} fictional matters)`);
store.close();
