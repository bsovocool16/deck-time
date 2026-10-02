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
  color         TEXT NOT NULL DEFAULT '#2f5d8a',
  task_code     TEXT NOT NULL DEFAULT '',
  activity_code TEXT NOT NULL DEFAULT '',
  code_set      TEXT NOT NULL DEFAULT '',   -- '' = no task/activity codes; else a key in config.codes.taskSets
  block_billing TEXT NOT NULL DEFAULT '',   -- '' = inherit from client | 'allowed' | 'prohibited'
  jurisdiction  TEXT NOT NULL DEFAULT '',   -- Intapp u1 code; '' = firm default
  guidelines    TEXT NOT NULL DEFAULT '',   -- matter-specific billing instructions (added to the client's)
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Billing rules remembered per client number; apply to all of its matters.
CREATE TABLE IF NOT EXISTS clients (
  client_no        TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '',
  no_block_billing INTEGER NOT NULL DEFAULT 0,
  guidelines       TEXT NOT NULL DEFAULT ''
);

-- Raw timer intervals. end_ms NULL = currently running.
CREATE TABLE IF NOT EXISTS segments (
  id        INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER,
  task      INTEGER NOT NULL DEFAULT 0   -- task number within the matter's day; "Next task" increments it
);
CREATE INDEX IF NOT EXISTS segments_time ON segments(start_ms, end_ms);

-- Billable entries. Part 0 is the matter's main entry for the day and gets the
-- timer hours not allocated to other parts; parts 1..n are split-off entries
-- with explicit hours (so the day always reconciles to the timer).
CREATE TABLE IF NOT EXISTS entries (
  date           TEXT NOT NULL,
  matter_id      INTEGER NOT NULL REFERENCES matters(id),
  part           INTEGER NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  narrative      TEXT NOT NULL DEFAULT '',
  hours_override REAL,
  task_code      TEXT NOT NULL DEFAULT '',   -- blank = use the matter's default
  activity_code  TEXT NOT NULL DEFAULT '',
  draft          TEXT NOT NULL DEFAULT '',   -- last instant draft, to learn from your edits
  jurisdiction   TEXT NOT NULL DEFAULT '',   -- Intapp u1 code; '' = the matter's
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | ready | exported
  exported_at    INTEGER,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (date, matter_id, part)
);

-- What each Stream Deck key does, by position (row * columns + column).
CREATE TABLE IF NOT EXISTS deck_layout (
  slot      INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL,              -- matter | dictate | next-task | stop | review | empty
  matter_id INTEGER REFERENCES matters(id)
);

-- Timestamped notes (typed or dictated) so work can be apportioned when splitting.
CREATE TABLE IF NOT EXISTS note_events (
  id        INTEGER PRIMARY KEY,
  date      TEXT NOT NULL,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  ts        INTEGER NOT NULL,
  text      TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'typed'   -- typed | dictated
);
CREATE INDEX IF NOT EXISTS note_events_day ON note_events(date, matter_id);
`;

const MATTER_FIELDS = ['client_no', 'matter_no', 'name', 'label', 'color', 'task_code', 'activity_code', 'code_set', 'block_billing', 'guidelines', 'jurisdiction', 'archived'];
const CLIENT_FIELDS = ['name', 'no_block_billing', 'guidelines'];
const ENTRY_FIELDS = ['notes', 'narrative', 'hours_override', 'task_code', 'activity_code', 'draft', 'jurisdiction', 'status'];
const STATUSES = new Set(['draft', 'ready', 'exported']);
const BLOCK_BILLING = new Set(['', 'allowed', 'prohibited']);
export const DECK_KINDS = new Set(['matter', 'dictate', 'next-task', 'stop', 'review', 'empty']);
const DECK_FUNCTIONS = ['dictate', 'next-task', 'stop']; // default right-hand keys

// Columns added after the first release: [table, column, definition]
const MIGRATIONS = [
  ['segments', 'task', 'INTEGER NOT NULL DEFAULT 0'],
  ['matters', 'code_set', "TEXT NOT NULL DEFAULT ''"],
  ['matters', 'block_billing', "TEXT NOT NULL DEFAULT ''"],
  ['matters', 'guidelines', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'task_code', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'activity_code', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'draft', "TEXT NOT NULL DEFAULT ''"],
  ['matters', 'jurisdiction', "TEXT NOT NULL DEFAULT ''"],
  ['entries', 'jurisdiction', "TEXT NOT NULL DEFAULT ''"],
  ['segments', 'confirmed', 'INTEGER NOT NULL DEFAULT 0'], // overnight check answered
];

const round2 = (n) => Math.round(n * 100) / 100;

// Restarting a matter within this long of its last stop continues the same task.
export const RESUME_WINDOW_MS = 15 * 60_000;

// Overnight check: a timer that ran past midnight with nothing logged for this
// long before the morning check hour is probably one you forgot to stop.
export const OVERNIGHT_QUIET_MS = 2 * 3_600_000;

export class Store extends EventEmitter {
  constructor(dbPath, getConfig, now = () => Date.now()) {
    super();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#migrateEntriesToParts();
    this.db.exec(SCHEMA);
    for (const [table, col, def] of MIGRATIONS) {
      if (!this.#columns(table).includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    this.getConfig = getConfig;
    this.now = now;
  }

  /** Hour the workday rolls over (0 = midnight). See time.js. */
  #rollover() {
    const h = Number(this.getConfig().overnight?.workdayEnds ?? 0);
    return Number.isInteger(h) && h >= 0 && h <= 6 ? h : 0;
  }

  /** The workday a moment belongs to. */
  dateOf(ms) {
    return localDate(ms, this.#rollover());
  }

  today() {
    return this.dateOf(this.now());
  }

  /** [start, end) of a workday in ms. */
  bounds(date) {
    return dayBounds(date, this.#rollover());
  }

  #columns(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  }

  /** v0.1 entries had PRIMARY KEY (date, matter_id); rebuild with a part column. */
  #migrateEntriesToParts() {
    const cols = this.#columns('entries');
    if (!cols.length || cols.includes('part')) return;
    const keep = cols.join(', ');
    this.db.exec(`BEGIN;
      ALTER TABLE entries RENAME TO entries_v1;
      ${SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS entries'), SCHEMA.indexOf('-- Timestamped notes'))}
      INSERT INTO entries (${keep}) SELECT ${keep} FROM entries_v1;
      DROP TABLE entries_v1;
      COMMIT;`);
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
    validateMatter(m);
    m.name = m.name.trim();
    if (!m.label) m.label = m.name.slice(0, 24);
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
    validateMatter(m);
    const cols = Object.keys(m);
    if (cols.length) {
      this.db.prepare(`UPDATE matters SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => m[c]), id);
    }
    if (m.archived) {
      this.stopIfRunning(id);
      this.db.prepare("UPDATE deck_layout SET kind = 'empty', matter_id = NULL WHERE matter_id = ?").run(id);
    }
    this.emitChange();
    return this.getMatter(id);
  }

  // ---------- Stream Deck layout ----------

  #deckSize() {
    const { columns = 4, rows = 2 } = this.getConfig().deck ?? {};
    return columns * rows;
  }

  /** Every key's assignment. Unsaved layouts default to the first matters, then Dictate / Next task / Stop. */
  deck() {
    const size = this.#deckSize();
    const saved = new Map(this.db.prepare('SELECT * FROM deck_layout').all().map((r) => [r.slot, plain(r)]));
    if (!saved.size) {
      const matters = this.listMatters().filter((m) => !/admin|non-billable/i.test(m.name));
      const fns = size < 6 ? [] : this.getConfig().features?.dictation === false ? ['next-task', 'stop'] : DECK_FUNCTIONS;
      return Array.from({ length: size }, (_, slot) => {
        const fnIndex = slot - (size - fns.length);
        if (fnIndex >= 0) return { slot, kind: fns[fnIndex], matter_id: null };
        const m = matters[slot];
        return m ? { slot, kind: 'matter', matter_id: m.id } : { slot, kind: 'empty', matter_id: null };
      });
    }
    return Array.from({ length: size }, (_, slot) => saved.get(slot) ?? { slot, kind: 'empty', matter_id: null });
  }

  #saveDeck(slots) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM deck_layout');
      const ins = this.db.prepare('INSERT INTO deck_layout (slot, kind, matter_id) VALUES (?, ?, ?)');
      for (const s of slots) ins.run(s.slot, s.kind, s.kind === 'matter' ? s.matter_id : null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.emitChange();
    return this.deck();
  }

  /** Put a matter or function on a key. A matter already on another key moves (no duplicates). */
  setDeckSlot(slot, { kind, matter_id }) {
    const slots = this.deck();
    if (!(slot >= 0 && slot < slots.length)) throw httpError(400, 'No such key');
    if (!DECK_KINDS.has(kind)) throw httpError(400, 'Unknown key type');
    if (kind === 'matter') {
      const m = this.getMatter(matter_id);
      if (!m || m.archived) throw httpError(400, 'Choose an active matter');
      for (const s of slots) if (s.kind === 'matter' && s.matter_id === m.id) Object.assign(s, { kind: 'empty', matter_id: null });
    }
    slots[slot] = { slot, kind, matter_id: kind === 'matter' ? +matter_id : null };
    return this.#saveDeck(slots);
  }

  swapDeckSlots(a, b) {
    const slots = this.deck();
    if (![a, b].every((x) => x >= 0 && x < slots.length)) throw httpError(400, 'No such key');
    [slots[a], slots[b]] = [
      { ...slots[b], slot: a },
      { ...slots[a], slot: b },
    ];
    return this.#saveDeck(slots);
  }

  // ---------- client billing rules ("memory") ----------

  getClient(clientNo) {
    const row = this.db.prepare('SELECT * FROM clients WHERE client_no = ?').get(clientNo);
    return row ? plain(row) : { client_no: clientNo, name: '', no_block_billing: 0, guidelines: '' };
  }

  /** Every client number in use by a matter, plus any with saved rules. */
  listClients() {
    const nos = this.db
      .prepare(`SELECT client_no FROM matters WHERE client_no != '' UNION SELECT client_no FROM clients ORDER BY client_no`)
      .all()
      .map((r) => r.client_no);
    return nos.map((no) => ({
      ...this.getClient(no),
      matters: this.db.prepare('SELECT id, name FROM matters WHERE client_no = ? AND archived = 0 ORDER BY name').all(no).map(plain),
    }));
  }

  updateClient(clientNo, input) {
    if (!clientNo?.trim()) throw httpError(400, 'Client number is required');
    const next = { ...this.getClient(clientNo), ...pick(input, CLIENT_FIELDS) };
    next.no_block_billing = next.no_block_billing ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO clients (client_no, name, no_block_billing, guidelines) VALUES (?, ?, ?, ?)
         ON CONFLICT (client_no) DO UPDATE SET name = excluded.name, no_block_billing = excluded.no_block_billing, guidelines = excluded.guidelines`,
      )
      .run(clientNo, next.name, next.no_block_billing, next.guidelines);
    this.emitChange();
    return this.getClient(clientNo);
  }

  /** Effective billing rules for a matter: matter settings override the client's. */
  rulesFor(matter) {
    const client = matter.client_no ? this.getClient(matter.client_no) : null;
    const noBlock = matter.block_billing ? matter.block_billing === 'prohibited' : !!client?.no_block_billing;
    const guidelines = [client?.guidelines, matter.guidelines].map((g) => g?.trim()).filter(Boolean).join('\n');
    return {
      no_block_billing: noBlock,
      source: matter.block_billing ? 'matter' : client?.no_block_billing ? 'client' : null,
      guidelines,
    };
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
        this.db.prepare('INSERT INTO segments (matter_id, start_ms, task) VALUES (?, ?, ?)').run(matterId, now, this.#resumeTask(matterId, now));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.emitChange();
    return this.running();
  }

  #currentTask(matterId, at) {
    // Includes a segment still running from before midnight, so tasks keep counting up across the rollover.
    const [start] = this.bounds(this.dateOf(at));
    const row = this.db.prepare('SELECT MAX(task) AS t FROM segments WHERE matter_id = ? AND COALESCE(end_ms, ?) > ?').get(matterId, at, start);
    return row?.t ?? 0;
  }

  /**
   * Task number for restarting a matter's timer. Coming back within a short
   * interruption (a call on another matter) continues the same task; after a
   * longer gap it's new work, so it starts a new task.
   */
  #resumeTask(matterId, at) {
    const [start] = this.bounds(this.dateOf(at));
    const last = this.db
      .prepare('SELECT task, end_ms FROM segments WHERE matter_id = ? AND end_ms > ? ORDER BY end_ms DESC LIMIT 1')
      .get(matterId, start);
    if (!last) return this.#currentTask(matterId, at);
    return at - last.end_ms <= RESUME_WINDOW_MS ? last.task : this.#currentTask(matterId, at) + 1;
  }

  /** Mark a task boundary on the running timer: close the current task and start the next on the same matter. */
  nextTask(label) {
    const current = this.running();
    if (!current) throw httpError(400, 'No timer running');
    const now = this.now();
    const task = this.#currentTask(current.matter_id, now) + 1;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE segments SET end_ms = ? WHERE id = ?').run(now, current.id);
      this.db.prepare('INSERT INTO segments (matter_id, start_ms, task) VALUES (?, ?, ?)').run(current.matter_id, now, task);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (label?.trim()) this.addNote(label, current.matter_id);
    else this.emitChange();
    return this.running();
  }

  /**
   * A matter's day grouped by task (as marked with "Next task"): time in each
   * task and the notes taken during it.
   */
  taskBlocks(date, matterId) {
    const [dayStart, dayEnd] = this.bounds(date);
    const now = this.now();
    const segs = this.segmentsForDay(date).filter((s) => s.matter_id === matterId);
    const blocks = new Map();
    for (const s of segs) {
      const start = Math.max(s.start_ms, dayStart);
      const end = Math.min(s.end_ms ?? now, dayEnd);
      const b = blocks.get(s.task) ?? { task: s.task, ms: 0, start, end, segments: [], notes: [] };
      b.ms += Math.max(end - start, 0);
      b.start = Math.min(b.start, start);
      b.end = Math.max(b.end, end);
      b.segments.push(s);
      blocks.set(s.task, b);
    }
    const list = [...blocks.values()].sort((a, b) => a.task - b.task);
    const { notes } = this.timeline(date, matterId);
    for (const n of notes) {
      // A note belongs to the task whose segment contains it; a note at a task
      // boundary belongs to the task that just started. Otherwise, the latest
      // task started before it.
      let owner = null;
      let ownerStart = -Infinity;
      for (const b of list) {
        for (const s of b.segments) {
          const inside = n.ts >= s.start_ms && (s.end_ms == null ? n.ts <= now : n.ts < s.end_ms);
          if (inside && s.start_ms >= ownerStart) [owner, ownerStart] = [b, s.start_ms];
        }
      }
      owner ??= [...list].reverse().find((b) => b.start <= n.ts) ?? list[0];
      owner?.notes.push(n);
    }
    return list.map(({ segments, ...b }) => b);
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

  /** Append a note to today's main entry for the running matter (or a given one), and log it with a timestamp. */
  /** ts: when the note was taken; for dictation, when speaking started (not when transcription finished). */
  addNote(text, matterId, source = 'typed', ts = this.now()) {
    const id = matterId ?? this.running()?.matter_id;
    if (!id) throw httpError(400, 'No timer running');
    const clean = text.trim();
    if (!clean) throw httpError(400, 'Note is empty');
    const date = this.dateOf(ts);
    this.db.prepare('INSERT INTO note_events (date, matter_id, ts, text, source) VALUES (?, ?, ?, ?, ?)').run(date, id, ts, clean, source);
    const entry = this.getEntry(date, id);
    const notes = entry.notes ? `${entry.notes}; ${clean}` : clean;
    return this.updateEntry(date, id, { notes });
  }

  /** What happened on a matter during a day: timer segments and timestamped notes. */
  timeline(date, matterId) {
    const segments = this.segmentsForDay(date).filter((s) => s.matter_id === matterId);
    const notes = this.db.prepare('SELECT ts, text, source FROM note_events WHERE date = ? AND matter_id = ? ORDER BY ts').all(date, matterId).map(plain);
    return { segments, notes };
  }

  segmentsForDay(date) {
    const [start, end] = this.bounds(date);
    const now = this.now();
    return this.db
      .prepare('SELECT * FROM segments WHERE start_ms < ? AND COALESCE(end_ms, ?) > ? ORDER BY start_ms')
      .all(end, now, start)
      .map(plain);
  }

  addSegment({ matter_id, start_ms, end_ms, task = 0 }) {
    if (!this.getMatter(matter_id)) throw httpError(404, 'Matter not found');
    if (!(end_ms > start_ms)) throw httpError(400, 'End must be after start');
    this.db.prepare('INSERT INTO segments (matter_id, start_ms, end_ms, task) VALUES (?, ?, ?, ?)').run(matter_id, start_ms, end_ms, task);
    this.emitChange();
  }

  updateSegment(id, input) {
    const seg = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
    if (!seg) throw httpError(404, 'Segment not found');
    const next = { ...plain(seg), ...pick(input, ['matter_id', 'start_ms', 'end_ms', 'task']) };
    if (next.end_ms != null && !(next.end_ms > next.start_ms)) throw httpError(400, 'End must be after start');
    this.db.prepare('UPDATE segments SET matter_id = ?, start_ms = ?, end_ms = ?, task = ? WHERE id = ?').run(next.matter_id, next.start_ms, next.end_ms, next.task, id);
    this.emitChange();
  }

  deleteSegment(id) {
    this.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
    this.emitChange();
  }

  // ---------- entries ----------

  getEntry(date, matterId, part = 0) {
    const row = this.db.prepare('SELECT * FROM entries WHERE date = ? AND matter_id = ? AND part = ?').get(date, matterId, part);
    return row
      ? plain(row)
      : { date, matter_id: matterId, part, notes: '', narrative: '', hours_override: null, task_code: '', activity_code: '', jurisdiction: '', status: 'draft', exported_at: null };
  }

  #parts(date, matterId) {
    return this.db.prepare('SELECT * FROM entries WHERE date = ? AND matter_id = ? ORDER BY part').all(date, matterId).map(plain);
  }

  updateEntry(date, matterId, input, part = 0) {
    if (!this.getMatter(matterId)) throw httpError(404, 'Matter not found');
    if (part > 0 && !this.db.prepare('SELECT 1 FROM entries WHERE date = ? AND matter_id = ? AND part = ?').get(date, matterId, part)) {
      throw httpError(404, 'Entry not found');
    }
    const patch = pick(input, ENTRY_FIELDS);
    if (patch.status && !STATUSES.has(patch.status)) throw httpError(400, 'Invalid status');
    if (part > 0 && 'hours_override' in patch && !(patch.hours_override > 0)) throw httpError(400, 'Split entries need hours');
    const next = { ...this.getEntry(date, matterId, part), ...patch };
    if (patch.status === 'exported') next.exported_at = this.now();
    this.#write(date, matterId, part, next);
    this.emitChange();
    return this.getEntry(date, matterId, part);
  }

  #write(date, matterId, part, e) {
    this.db
      .prepare(
        `INSERT INTO entries (date, matter_id, part, notes, narrative, hours_override, task_code, activity_code, draft, jurisdiction, status, exported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (date, matter_id, part) DO UPDATE SET
           notes = excluded.notes, narrative = excluded.narrative, hours_override = excluded.hours_override,
           task_code = excluded.task_code, activity_code = excluded.activity_code, draft = excluded.draft,
           jurisdiction = excluded.jurisdiction,
           status = excluded.status, exported_at = excluded.exported_at, updated_at = excluded.updated_at`,
      )
      .run(date, matterId, part, e.notes ?? '', e.narrative ?? '', e.hours_override ?? null, e.task_code ?? '', e.activity_code ?? '', e.draft ?? '', e.jurisdiction ?? '', e.status ?? 'draft', e.exported_at ?? null, this.now());
  }

  /** Split off a new entry for the same matter/day. Its hours come out of the main entry's. */
  addPart(date, matterId, input = {}) {
    if (!this.getMatter(matterId)) throw httpError(404, 'Matter not found');
    const hours = Number(input.hours_override ?? input.hours ?? 0.1);
    if (!(hours > 0)) throw httpError(400, 'Split entries need hours');
    if (!this.#parts(date, matterId).some((p) => p.part === 0)) this.#write(date, matterId, 0, {});
    const { next } = this.db.prepare('SELECT COALESCE(MAX(part), 0) + 1 AS next FROM entries WHERE date = ? AND matter_id = ?').get(date, matterId);
    this.#write(date, matterId, next, { ...pick(input, ENTRY_FIELDS), hours_override: hours, status: 'draft' });
    this.emitChange();
    return this.getEntry(date, matterId, next);
  }

  deletePart(date, matterId, part) {
    if (!(part > 0)) throw httpError(400, "The main entry can't be deleted; clear it instead");
    this.db.prepare('DELETE FROM entries WHERE date = ? AND matter_id = ? AND part = ?').run(date, matterId, part);
    this.emitChange();
  }

  /**
   * Replace a matter's entries for the day with a split: the first item becomes
   * the main entry (keeps the remainder of the timer hours), the rest become
   * split-off entries with the given hours.
   */
  applySplit(date, matterId, items) {
    if (!this.getMatter(matterId)) throw httpError(404, 'Matter not found');
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'Nothing to apply');
    if (items.slice(1).some((i) => !(Number(i.hours) > 0))) throw httpError(400, 'Every split entry needs hours');
    const main = this.getEntry(date, matterId, 0);
    // Normally the main entry keeps the timer remainder. If the split's total
    // differs from the timer (e.g. per-task minimums), pin its hours instead.
    const timer = this.day(date).entries.find((e) => e.matter_id === matterId && e.part === 0)?.computed_hours ?? 0;
    const splitTotal = round2(items.reduce((sum, i) => sum + (Number(i.hours) || 0), 0));
    const pinMain = Number(items[0].hours) > 0 && Math.abs(splitTotal - timer) > 0.001;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM entries WHERE date = ? AND matter_id = ? AND part > 0').run(date, matterId);
      const [first, ...rest] = items;
      this.#write(date, matterId, 0, {
        ...main,
        ...pick(first, ['notes', 'narrative', 'task_code', 'activity_code']),
        hours_override: pinMain ? round2(Number(first.hours)) : null,
        status: 'draft',
      });
      rest.forEach((item, i) => {
        this.#write(date, matterId, i + 1, { ...pick(item, ['notes', 'narrative', 'task_code', 'activity_code', 'draft']), hours_override: round2(Number(item.hours)), status: 'draft' });
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.emitChange();
    return this.day(date).entries.filter((e) => e.matter_id === matterId);
  }

  /** Everything for one day: entries (all parts) for every matter with time or a saved entry. */
  day(date) {
    const [start, end] = this.bounds(date);
    const now = this.now();
    const rounding = this.getConfig().rounding;
    const rawByMatter = new Map();
    for (const s of this.segmentsForDay(date)) {
      const ms = Math.min(s.end_ms ?? now, end) - Math.max(s.start_ms, start);
      rawByMatter.set(s.matter_id, (rawByMatter.get(s.matter_id) ?? 0) + Math.max(ms, 0));
    }
    for (const row of this.db.prepare('SELECT DISTINCT matter_id FROM entries WHERE date = ?').all(date)) {
      if (!rawByMatter.has(row.matter_id)) rawByMatter.set(row.matter_id, 0);
    }
    const running = this.running();
    const entries = [];
    for (const [matterId, rawMs] of rawByMatter) {
      const matter = this.getMatter(matterId);
      const rules = this.rulesFor(matter);
      const usesCodes = !!matter.code_set;
      const computed = roundHours(rawMs, rounding);
      const rows = this.#parts(date, matterId);
      if (!rows.some((r) => r.part === 0)) rows.unshift(this.getEntry(date, matterId, 0));
      const splitHours = round2(rows.filter((r) => r.part > 0).reduce((s, r) => s + (r.hours_override ?? 0), 0));
      const remainder = round2(computed - splitHours);
      for (const row of rows) {
        const isMain = row.part === 0;
        const hours = isMain ? (row.hours_override ?? Math.max(remainder, 0)) : row.hours_override;
        entries.push({
          ...row,
          matter,
          rules,
          // Effective codes: the entry's own, else the matter default; none if the matter doesn't use codes.
          jx: row.jurisdiction || matter.jurisdiction || '', // '' = firm default at export
          task: usesCodes ? row.task_code || matter.task_code : '',
          activity: usesCodes ? row.activity_code || matter.activity_code : '',
          raw_ms: isMain ? rawMs : 0,
          computed_hours: computed, // timer total for the matter (all parts)
          split_hours: splitHours,
          over_allocated: isMain && row.hours_override == null && remainder < 0,
          parts: rows.length,
          hours,
          block_warning: rules.no_block_billing && looksBlockBilled(row.narrative),
          running: isMain && running?.matter_id === matterId,
        });
      }
    }
    entries.sort((a, b) => a.matter.name.localeCompare(b.matter.name) || a.part - b.part);
    const total = round2(entries.reduce((sum, e) => sum + e.hours, 0));
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

  // ---------- overnight check ----------

  /**
   * A timer that started before midnight and was still going at the morning
   * check hour, with nothing logged on it for a couple of hours: probably
   * left running overnight. Asked once per timer; otherwise time that crosses
   * midnight simply lands on each day it was worked (or on the day it started,
   * with a later workday rollover). Returns null when there's nothing to ask.
   */
  overnight() {
    const cfg = { check: true, checkHour: 5, ...this.getConfig().overnight };
    if (!cfg.check) return null;
    const now = this.now();
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE confirmed = 0 AND start_ms > ? AND COALESCE(end_ms, ?) > ? ORDER BY start_ms')
      .all(now - 2 * 86_400_000, now, now - 86_400_000)
      .map(plain);
    for (const s of rows) {
      const started = new Date(s.start_ms);
      const checkAt = new Date(started.getFullYear(), started.getMonth(), started.getDate() + 1, cfg.checkHour).getTime();
      const end = s.end_ms ?? now;
      if (end < checkAt) continue;
      const last = this.db
        .prepare('SELECT ts, text FROM note_events WHERE matter_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
        .get(s.matter_id, s.start_ms, end);
      const lastActivity = Math.max(s.start_ms, last?.ts ?? 0);
      if (checkAt - lastActivity < OVERNIGHT_QUIET_MS) continue; // you were logging work into the small hours
      const midnight = new Date(started.getFullYear(), started.getMonth(), started.getDate() + 1).getTime();
      return {
        segment_id: s.id,
        matter: this.getMatter(s.matter_id),
        start_ms: s.start_ms,
        end_ms: s.end_ms, // null while it's still running
        running: s.end_ms == null,
        midnight_ms: midnight,
        last_note: last ? { ts: last.ts, text: last.text } : null,
      };
    }
    return null;
  }

  /** Answer the overnight check: keep the time, or end the timer at a given moment. */
  resolveOvernight(segmentId, { action, end_ms } = {}) {
    const seg = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId);
    if (!seg) throw httpError(404, 'Timer not found');
    if (action === 'keep') {
      this.db.prepare('UPDATE segments SET confirmed = 1 WHERE id = ?').run(segmentId);
    } else if (action === 'end') {
      const limit = seg.end_ms ?? this.now();
      const at = Number(end_ms);
      if (!(at > seg.start_ms) || at > limit) throw httpError(400, 'Choose a time between when the timer started and now');
      this.db.prepare('UPDATE segments SET end_ms = ?, confirmed = 1 WHERE id = ?').run(Math.round(at), segmentId);
    } else throw httpError(400, "action must be 'keep' or 'end'");
    this.emitChange();
    return { ok: true };
  }

  // ---------- state snapshot for UI / Stream Deck ----------

  state() {
    const running = this.running();
    const today = this.today();
    const { entries, total_hours } = this.day(today);
    const todayMs = Object.fromEntries(entries.filter((e) => e.part === 0).map((e) => [e.matter_id, e.raw_ms]));
    return {
      now: this.now(),
      today,
      total_hours,
      running: running
        ? { ...running, matter: this.getMatter(running.matter_id), tasks_today: this.taskBlocks(today, running.matter_id).length }
        : null,
      matters: this.listMatters().map((m) => ({ ...m, today_ms: todayMs[m.id] ?? 0 })),
      deck: this.deck(),
      overnight: this.overnight(),
    };
  }

  emitChange() {
    this.emit('change');
  }
}

/**
 * Heuristic: does a narrative bundle several tasks? Semicolons joining clauses,
 * or "and"/"then" followed by another past-tense verb ("Reviewed X and drafted Y").
 */
export function looksBlockBilled(narrative = '') {
  const text = narrative.trim();
  if (!text) return false;
  if (text.split(';').filter((p) => p.trim().length > 3).length > 1) return true;
  // "Reviewed and analyzed X" is one task (verb pair up front); "Reviewed X and drafted Y" is two.
  const joiner = /,?\s+(?:and|then)\s+(?:also\s+)?([a-z]+ed|drafted|wrote|sent|met|spoke|attended|began|prepared|led)\b/gi;
  for (const m of text.matchAll(joiner)) {
    const wordsBefore = text.slice(0, m.index).trim().split(/\s+/).length;
    if (wordsBefore >= 2 && !NOT_TASK_VERBS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// Past-tense words that usually describe a noun, not a second task ("and related matters").
const NOT_TASK_VERBS = new Set([
  'related', 'associated', 'proposed', 'amended', 'restated', 'executed', 'requested', 'required', 'attached',
  'enclosed', 'combined', 'continued', 'detailed', 'limited', 'certified', 'affiliated',
]);

function validateMatter(m) {
  if ('block_billing' in m && !BLOCK_BILLING.has(m.block_billing)) throw httpError(400, 'Invalid block billing setting');
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
