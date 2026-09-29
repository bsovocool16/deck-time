// Seeds fictional matters into the demo data dir (data/demo). Never touches ~/.deck-time.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'demo');
process.env.DECK_TIME_HOME = home;
fs.mkdirSync(home, { recursive: true });
const { DB_PATH, loadConfig } = await import('../companion/src/config.js');
const { Store } = await import('../companion/src/store.js');

const config = loadConfig();
const store = new Store(DB_PATH, () => config);
if (store.listMatters({ includeArchived: true }).length) {
  console.log('demo already seeded:', DB_PATH);
} else {
  const matters = [
    { name: 'Acme / Globex Merger', label: 'Acme M&A', client_no: '10234', matter_no: '0007', color: '#2f5d8a' },
    { name: 'Initech Credit Facility', label: 'Initech Loan', client_no: '20411', matter_no: '0002', color: '#3f7d52' },
    { name: 'Umbrella Corp 10-K', label: 'Umbrella 10-K', client_no: '30877', matter_no: '0015', color: '#9a3b36' },
    { name: 'Stark Industries Board', label: 'Stark Board', client_no: '41120', matter_no: '0001', color: '#6b4f8a' },
    { name: 'Wayne Ent. Fairness Opinion', label: 'Wayne FO', client_no: '52009', matter_no: '0004', color: '#b0702a' },
    { name: 'Firm Admin (non-billable)', label: 'Admin', client_no: '99999', matter_no: '0000', color: '#7a7a74' },
  ];
  for (const m of matters) store.createMatter(m);
  console.log(`seeded ${matters.length} fictional matters into`, DB_PATH);
}
store.close();
