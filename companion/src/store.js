import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { dayBounds, localDate, roundHours } from './time.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matters (
  id            INTEGER PRIMARY KEY,
  client_no     TEXT NOT NULL DEFAULT '',
  matter_no     TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',   -- short text for the Stream Deck key
  color         TEXT NOT NULL DEFAULT '#3b82f6',
  task_code     TEXT NOT NULL DEFAULT '',
  activity_code TEXT NOT NULL DEFAULT '',
  code_set      TEXT NOT NULL DEFAULT '',  -- '' = no task/activity codes; else a key in config.codes.taskSets
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Raw timer intervals. end_ms NULL = currently running.
CREATE TABLE IF NOT EXISTS segments (
  id        INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS segments_time ON segments(start_ms, end_ms);

-- One billable entry per (date, matter). Hours are derived from segments
-- unless hours_override is set.
CREATE TABLE IF NOT EXISTS entries (
  date           TEXT NOT NULL,
  matter_id      INTEGER NOT NULL REFERENCES matters(id),
  notes          TEXT NOT NULL DEFAULT '',
  narrative      TEXT NOT NULL DEFAULT '',
  hours_override REAL,
  task_code      TEXT NOT NULL DEFAULT '',   -- blank = use the matter's default
  activity_code  TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | ready | exported
  exported_at    INTEGER,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (date, matter_id)
);
`;

const MATTER_FIELDS = ['client_no', 'matter_no', 'name', 'label', 'color', 'task_code', 'activity_code', 'code_set', 'archived'];
const ENTRY_FIELDS = ['notes', 'narrative', 'hours_override', 'task_code', 'activity_code', 'status'];

// Columns added after the first release: [table, column, definition]
const MIGRATIONS = [
  ['matters', 'code_set', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'task_code', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'activity_code', "TEXT NOT NULL DEFAULT ''"],
];
const STATUSES = new Set(['draft', 'ready', 'exported']);

export class Store extends EventEmitter {
  constructor(dbPath, getConfig, now = () => Date.now()) {
    super();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    for (const [table, col, def] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    this.getConfig = getConfig;
    this.now = now;
  }

  close() {
    this.db.close();
  }

  // ---------- matters ----------

  listMatters({ includeArchived = false } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM matters ORDER BY archived, name'
      : 'SELECT * FROM matters WHERE archived = 0 ORDER BY name';
    return this.db.prepare(sql).all().map(plain);
  }

  getMatter(id) {
    const m = this.db.prepare('SELECT * FROM matters WHERE id = ?').get(id);
    return m ? plain(m) : null;
  }

  createMatter(input) {
    if (!input?.name?.trim()) throw httpError(400, 'Matter name is required');
    const m = pick(input, MATTER_FIELDS);
    m.name = m.name.trim();
    if (!m.label) m.label = m.name.slice(0, 14);
    const cols = Object.keys(m);
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO matters (${cols.join(', ')}, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`)
      .run(...cols.map((c) => m[c]), this.now());
    this.emitChange();
    return this.getMatter(Number(lastInsertRowid));
  }

  updateMatter(id, input) {
    if (!this.getMatter(id)) throw httpError(404, 'Matter not found');
    const m = pick(input, MATTER_FIELDS);
    const cols = Object.keys(m);
    if (cols.length) {
      this.db.prepare(`UPDATE matters SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => m[c]), id);
    }
    if (m.archived) this.stopIfRunning(id);
    this.emitChange();
    return this.getMatter(id);
  }

  // ---------- timers ----------

  running() {
    const s = this.db.prepare('SELECT * FROM segments WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT 1').get();
    return s ? plain(s) : null;
  }

  /** Start the matter's timer (stopping any other), or stop it if it's the one running. */
  toggle(matterId) {
    const matter = this.getMatter(matterId);
    if (!matter) throw httpError(404, 'Matter not found');
    const current = this.running();
    const now = this.now();
    this.db.exec('BEGIN');
    try {
      if (current) this.db.prepare('UPDATE segments SET end_ms = ? WHERE id = ?').run(now, current.id);
      if (!current || current.matter_id !== matterId) {
        if (matter.archived) throw httpError(400, 'Matter is archived');
        this.db.prepare('INSERT INTO segments (matter_id, start_ms) VALUES (?, ?)').run(matterId, now);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.emitChange();
    return this.running();
  }

  stop() {
    const current = this.running();
    if (current) {
      this.db.prepare('UPDATE segments SET end_ms = ? WHERE id = ?').run(this.now(), current.id);
      this.emitChange();
    }
    return null;
  }

  stopIfRunning(matterId) {
    const current = this.running();
    if (current?.matter_id === matterId) this.stop();
  }

  /** Append a quick note to today's entry for the running matter (or a given one). */
  addNote(text, matterId) {
    const id = matterId ?? this.running()?.matter_id;
    if (!id) throw httpError(400, 'No timer running');
    const date = localDate(this.now());
    const entry = this.getEntry(date, id);
    const notes = entry.notes ? `${entry.notes}; ${text.trim()}` : text.trim();
    return this.updateEntry(date, id, { notes });
  }

  segmentsForDay(date) {
    const [start, end] = dayBounds(date);
    const now = this.now();
    return this.db
      .prepare('SELECT * FROM segments WHERE start_ms < ? AND COALESCE(end_ms, ?) > ? ORDER BY start_ms')
      .all(end, now, start)
      .map(plain);
  }

  addSegment({ matter_id, start_ms, end_ms }) {
    if (!this.getMatter(matter_id)) throw httpError(404, 'Matter not found');
    if (!(end_ms > start_ms)) throw httpError(400, 'End must be after start');
    this.db.prepare('INSERT INTO segments (matter_id, start_ms, end_ms) VALUES (?, ?, ?)').run(matter_id, start_ms, end_ms);
    this.emitChange();
  }

  updateSegment(id, input) {
    const seg = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
    if (!seg) throw httpError(404, 'Segment not found');
    const next = { ...plain(seg), ...pick(input, ['matter_id', 'start_ms', 'end_ms']) };
    if (next.end_ms != null && !(next.end_ms > next.start_ms)) throw httpError(400, 'End must be after start');
    this.db.prepare('UPDATE segments SET matter_id = ?, start_ms = ?, end_ms = ? WHERE id = ?').run(next.matter_id, next.start_ms, next.end_ms, id);
    this.emitChange();
  }

  deleteSegment(id) {
    this.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
    this.emitChange();
  }

  // ---------- entries ----------

  getEntry(date, matterId) {
    const row = this.db.prepare('SELECT * FROM entries WHERE date = ? AND matter_id = ?').get(date, matterId);
    return row
      ? plain(row)
      : { date, matter_id: matterId, notes: '', narrative: '', hours_override: null, task_code: '', activity_code: '', status: 'draft', exported_at: null };
  }

  updateEntry(date, matterId, input) {
    if (!this.getMatter(matterId)) throw httpError(404, 'Matter not found');
    const patch = pick(input, ENTRY_FIELDS);
    if (patch.status && !STATUSES.has(patch.status)) throw httpError(400, 'Invalid status');
    const next = { ...this.getEntry(date, matterId), ...patch };
    if (patch.status === 'exported') next.exported_at = this.now();
    this.db
      .prepare(
        `INSERT INTO entries (date, matter_id, notes, narrative, hours_override, task_code, activity_code, status, exported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date, matter_id) DO UPDATE SET
           notes = excluded.notes, narrative = excluded.narrative, hours_override = excluded.hours_override,
           task_code = excluded.task_code, activity_code = excluded.activity_code,
           status = excluded.status, exported_at = excluded.exported_at, updated_at = excluded.updated_at`,
      )
      .run(date, matterId, next.notes, next.narrative, next.hours_override, next.task_code, next.activity_code, next.status, next.exported_at, this.now());
    this.emitChange();
    return this.getEntry(date, matterId);
  }

  /** Everything for one day: an entry per matter that has time or an entry row. */
  day(date) {
    const [start, end] = dayBounds(date);
    const now = this.now();
    const rounding = this.getConfig().rounding;
    const byMatter = new Map();
    for (const s of this.segmentsForDay(date)) {
      const ms = Math.min(s.end_ms ?? now, end) - Math.max(s.start_ms, start);
      byMatter.set(s.matter_id, (byMatter.get(s.matter_id) ?? 0) + Math.max(ms, 0));
    }
    for (const row of this.db.prepare('SELECT matter_id FROM entries WHERE date = ?').all(date)) {
      if (!byMatter.has(row.matter_id)) byMatter.set(row.matter_id, 0);
    }
    const running = this.running();
    const entries = [...byMatter.entries()].map(([matterId, rawMs]) => {
      const entry = this.getEntry(date, matterId);
      const computed = roundHours(rawMs, rounding);
      const matter = this.getMatter(matterId);
      const usesCodes = !!matter.code_set;
      return {
        ...entry,
        matter,
        // Effective codes: the entry's own, else the matter default; none if the matter doesn't use codes.
        task: usesCodes ? entry.task_code || matter.task_code : '',
        activity: usesCodes ? entry.activity_code || matter.activity_code : '',
        raw_ms: rawMs,
        computed_hours: computed,
        hours: entry.hours_override ?? computed,
        running: running?.matter_id === matterId,
      };
    });
    entries.sort((a, b) => a.matter.name.localeCompare(b.matter.name));
    const total = Math.round(entries.reduce((sum, e) => sum + e.hours, 0) * 100) / 100;
    return { date, entries, total_hours: total };
  }

  /** Recent accepted narratives for a matter, used as style examples for the AI. */
  recentNarratives(matterId, limit = 3) {
    return this.db
      .prepare(
        `SELECT notes, narrative FROM entries
         WHERE matter_id = ? AND narrative != '' AND status IN ('ready', 'exported')
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(matterId, limit)
      .map(plain);
  }

  // ---------- state snapshot for UI / Stream Deck ----------

  state() {
    const running = this.running();
    const today = localDate(this.now());
    const { entries, total_hours } = this.day(today);
    const todayMs = Object.fromEntries(entries.map((e) => [e.matter_id, e.raw_ms]));
    return {
      now: this.now(),
      today,
      total_hours,
      running: running ? { ...running, matter: this.getMatter(running.matter_id) } : null,
      matters: this.listMatters().map((m) => ({ ...m, today_ms: todayMs[m.id] ?? 0 })),
    };
  }

  emitChange() {
    this.emit('change');
  }
}

function plain(row) {
  return { ...row };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
