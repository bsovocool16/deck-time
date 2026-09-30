// Command-line entry: `npm start` (full edition) or DECK_TIME_EDITION=office.
import { startCompanion } from './host.js';

const app = await startCompanion({ edition: process.env.DECK_TIME_EDITION || 'full' });
const shutdown = () => {
  app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
