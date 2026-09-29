// Local-time date helpers. Dates are 'YYYY-MM-DD' strings in the machine's timezone.

const pad = (n) => String(n).padStart(2, '0');

export function localDate(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayBounds(date) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime(); // DST-safe: next local midnight
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
