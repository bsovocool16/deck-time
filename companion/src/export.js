import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Intapp Time .TIM format (reverse-engineered from a real export, 2026-09-29)
//
// One entry per line, CRLF endings. Each line is `key=value` pairs joined by
// `|`, keys in alphabetical order. Per-entry fields we generate:
//
//   am        duration in SECONDS (1.2 h = 4320)
//   cl        client number                     e.g. 123456
//   ma        client.matter                     e.g. 123456.00001
//   na        narrative
//   tk/op/lmb timekeeper / operator / last-modified-by (timekeeper id)
//   wd        work date        "M/D/YYYY 12:00:00 AM"
//   ed/md     entry/modified   "M/D/YYYY h:mm:ss AM" (export time)
//   ref       GUID, unique per entry
//   ss        "888888" + am zero-padded to 6 digits (observed; prefix may encode
//             billing type — both samples were 99xxxx matters)
//   u1        jurisdiction code (constant, copied from the export)
//   u5 / u6   UTBMS task / activity code — only on matters that require them
//
// `ar` and `shortref` look like record ids Intapp assigns itself, so we omit
// them. Everything else is copied from config.tim.defaults (taken verbatim
// from the sample export).
// ---------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "9/29/2026 10:12:16 PM" */
export function intappDateTime(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
}

/** "2026-09-29" -> "9/29/2026 12:00:00 AM" */
export function intappWorkDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}/${y} 12:00:00 AM`;
}

export function hoursToSeconds(hours) {
  return Math.round(hours * 3600);
}

/** Entries worth exporting: has hours, not already exported (unless asked). */
export function exportable(entries, { includeExported = false } = {}) {
  return entries.filter((e) => e.hours > 0 && (includeExported || e.status !== 'exported'));
}

/** Values can't contain the delimiter or line breaks. */
function clean(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function timRecord(entry, config, { now = Date.now(), uuid = randomUUID } = {}) {
  const tk = String(config.timekeeper.id ?? '').trim();
  const am = hoursToSeconds(entry.hours);
  const stamp = intappDateTime(now);
  const client = String(entry.matter.client_no ?? '').trim();
  const matter = String(entry.matter.matter_no ?? '').trim();
  const record = {
    ...config.tim.defaults,
    am: String(am),
    cl: client,
    ma: matter ? `${client}.${matter}` : client,
    na: entry.narrative,
    tk,
    op: tk,
    lmb: tk,
    wd: intappWorkDate(entry.date),
    ed: stamp,
    md: stamp,
    ref: uuid(),
    ss: `${config.tim.ssPrefix}${pad(am, 6)}`,
  };
  if (entry.task) record.u5 = entry.task;
  if (entry.activity) record.u6 = entry.activity;
  return record;
}

export function toTim(entries, config, opts) {
  const lines = entries.map((e) => {
    const rec = timRecord(e, config, opts);
    return Object.keys(rec)
      .sort()
      .map((k) => `${k}=${clean(rec[k])}`)
      .join('|');
  });
  return lines.map((l) => l + '\r\n').join('');
}

/** Problems that would make Intapp reject (or mis-file) an export. */
export function validateForTim(entries, config) {
  const problems = [];
  if (!String(config.timekeeper.id ?? '').trim()) problems.push('Set your timekeeper ID in Settings');
  for (const e of entries) {
    if (!e.narrative?.trim()) problems.push(`${e.matter.name}: missing narrative`);
    if (!e.matter.client_no) problems.push(`${e.matter.name}: missing client number`);
    if (!e.matter.matter_no) problems.push(`${e.matter.name}: missing matter number`);
    if (e.matter.code_set && (!e.task || !e.activity)) problems.push(`${e.matter.name}: needs task/activity codes`);
  }
  return problems;
}

// ---------- CSV (for spreadsheets / sanity checks) ----------

const CSV_COLUMNS = [
  ['date', (e) => e.date],
  ['client', (e) => e.matter.client_no],
  ['matter', (e) => e.matter.matter_no],
  ['matter_name', (e) => e.matter.name],
  ['hours', (e) => e.hours.toFixed(1)],
  ['task_code', (e) => e.task ?? ''],
  ['activity_code', (e) => e.activity ?? ''],
  ['narrative', (e) => e.narrative],
];

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(entries) {
  const rows = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const e of entries) rows.push(CSV_COLUMNS.map(([, f]) => csvCell(f(e))).join(','));
  return rows.join('\r\n') + '\r\n';
}

// ---------- reading .TIM files ----------

export function parseTim(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) =>
      Object.fromEntries(
        line.split('|').map((pair) => {
          const i = pair.indexOf('=');
          return i < 0 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)];
        }),
      ),
    );
}

const PER_ENTRY = new Set(['am', 'ar', 'cl', 'ma', 'na', 'tk', 'op', 'lmb', 'wd', 'ed', 'md', 'ref', 'shortref', 'ss', 'u5', 'u6']);

/** Summarize a .TIM file and derive config (defaults + timekeeper) from it. */
export function learnFromTim(text) {
  const records = parseTim(text);
  if (!records.length || !records[0].am) throw Object.assign(new Error("That doesn't look like an Intapp .TIM export"), { status: 400 });
  const keys = [...new Set(records.flatMap(Object.keys))].sort();
  const constant = {};
  const varying = [];
  for (const k of keys) {
    const values = new Set(records.map((r) => r[k]));
    if (!PER_ENTRY.has(k) && values.size === 1) constant[k] = [...values][0];
    else varying.push(k);
  }
  const unknownVarying = varying.filter((k) => !PER_ENTRY.has(k));
  const ss = records[0].ss && records[0].am ? records[0].ss.slice(0, records[0].ss.length - 6) : '888888';
  return {
    entries: records.length,
    keys,
    defaults: constant,
    ssPrefix: ss,
    timekeeperId: records[0].tk ?? '',
    unknownVarying, // fields we don't generate that differ between entries — investigate
    records,
  };
}
