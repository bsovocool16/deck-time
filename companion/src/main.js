// Command-line entry: `npm start` (full edition). Works the same on macOS and Windows:
//   node companion/src/main.js [--edition office] [--home <data folder>]
// (DECK_TIME_EDITION and DECK_TIME_HOME still work too.)
import { startCompanion } from './host.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const app = await startCompanion({
  edition: arg('edition') || process.env.DECK_TIME_EDITION || 'full',
  ...(arg('home') ? { home: arg('home') } : {}),
});
const shutdown = () => {
  app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
