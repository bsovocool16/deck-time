// Usage: npm run tim:inspect -- file.TIM          summarize an Intapp .TIM export
//        npm run tim:learn   -- file.TIM          ...and save its format to your local config
import fs from 'node:fs';
import { learnFromTim } from '../companion/src/export.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run tim:inspect -- path/to/export.TIM [--apply]');
  process.exit(1);
}

const learned = learnFromTim(fs.readFileSync(file, 'utf8'));
console.log(`${learned.entries} entr${learned.entries === 1 ? 'y' : 'ies'}, ${learned.keys.length} keys`);
for (const [i, r] of learned.records.entries()) {
  console.log(`  #${i + 1}  ${r.wd?.split(' ')[0]}  ${r.ma}  ${(Number(r.am) / 3600).toFixed(2)} h  "${r.na}"`);
}
console.log('\nConstant fields:', learned.defaults);
console.log('Timekeeper ID:', learned.timekeeperId || '(none)');
if (learned.unknownVarying.length) console.log('⚠ Unrecognized fields that vary between entries:', learned.unknownVarying.join(', '));

if (apply) {
  const { loadConfig, saveConfig, CONFIG_PATH } = await import('../companion/src/config.js');
  const cfg = loadConfig();
  cfg.tim = { ...cfg.tim, defaults: learned.defaults, ssPrefix: learned.ssPrefix };
  if (!cfg.timekeeper.id) cfg.timekeeper.id = learned.timekeeperId;
  saveConfig(cfg);
  console.log(`\nSaved to ${CONFIG_PATH}`);
}
