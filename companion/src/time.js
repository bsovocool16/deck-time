// Local-time date helpers. Dates are 'YYYY-MM-DD' strings in the machine's timezone.

const pad = (n) => String(n).padStart(2, '0');

// A workday normally ends at midnight. With `rollover` set (an hour, e.g. 4),
// time before that hour counts toward the previous day, so a late night stays
// on the day it started.

export function localDate(ms = Date.now(), rollover = 0) {
  const t = new Date(ms);
  const d = t.getHours() < rollover ? new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1) : t;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayBounds(date, rollover = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, rollover).getTime();
  const end = new Date(y, m - 1, d + 1, rollover).getTime(); // DST-safe: next local midnight (or rollover hour)
  return [start, end];
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Round raw milliseconds to billable hours per the rounding config. */
export function roundHours(ms, { increment = 0.1, mode = 'up', minimum = 0.1 } = {}) {
  if (ms <= 0) return 0;
  const hours = ms / 3_600_000;
  const steps = hours / increment;
  // Small epsilon so exactly 6:00 minutes stays 0.1, not 0.2.
  const n = mode === 'nearest' ? Math.round(steps) : Math.ceil(steps - 1e-9);
  const rounded = Math.max(n * increment, minimum);
  return Math.round(rounded * 100) / 100;
}

export function formatDate(date, fmt) {
  const [y, m, d] = date.split('-');
  const tokens = { YYYY: y, YY: y.slice(2), MM: m, DD: d, M: String(+m), D: String(+d) };
  return fmt.replace(/YYYY|YY|MM|DD|M|D/g, (t) => tokens[t]);
}
