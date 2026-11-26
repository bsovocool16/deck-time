// node:sqlite's DatabaseSync on top of sql.js (SQLite compiled to WebAssembly).
// The database lives in memory and is written back to its file shortly after
// each change, so the companion's Store runs unchanged.
import { rt } from './runtime.js';
import fs from './fs.js';

const open = new Set();
const value = (v) => (v === undefined ? null : typeof v === 'boolean' ? +v : typeof v === 'bigint' ? Number(v) : v);
const bindings = (params) =>
  params.length === 1 && params[0] && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)
    ? Object.fromEntries(Object.entries(params[0]).map(([k, v]) => [/^[:@$]/.test(k) ? k : `$${k}`, value(v)]))
    : params.map(value);
const WRITES = /^\s*(insert|update|delete|replace|create|drop|alter|begin|commit|rollback|pragma\s+\w+\s*=)/i;
const ANY_WRITE = /\b(insert|update|delete|replace|create|drop|alter)\b/i;

export class DatabaseSync {
  constructor(path) {
    this.path = path;
    const bytes = path && path !== ':memory:' && fs.existsSync(path) ? fs.readFileSync(path) : null;
    this.db = new rt.SQL.Database(bytes && bytes.length ? bytes : undefined);
    this.timer = null;
    open.add(this);
  }
  exec(sql) {
    this.db.exec(sql);
    if (ANY_WRITE.test(sql)) this.#changed();
  }
  prepare(sql) {
    const self = this;
    const step = (params, fn) => {
      const st = self.db.prepare(sql);
      try {
        const b = bindings(params);
        if (Array.isArray(b) ? b.length : Object.keys(b).length) st.bind(b);
        return fn(st);
      } finally {
        st.free();
      }
    };
    return {
      get: (...p) => step(p, (st) => (st.step() ? { ...st.getAsObject() } : undefined)),
      all: (...p) =>
        step(p, (st) => {
          const rows = [];
          while (st.step()) rows.push({ ...st.getAsObject() });
          return rows;
        }),
      run: (...p) => {
        step(p, (st) => st.step());
        const changes = self.db.getRowsModified();
        const id = self.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0;
        if (WRITES.test(sql)) self.#changed();
        return { changes, lastInsertRowid: id };
      },
    };
  }
  #changed() {
    if (!this.path || this.path === ':memory:') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 250);
  }
  /** Write the database to its file now. */
  save() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.db) return;
    const bytes = this.db.export(); // sql.js resets pragmas on export
    this.db.exec('PRAGMA foreign_keys = ON;');
    fs.writeFileSync(this.path, bytes);
  }
  close() {
    if (this.timer) this.save();
    this.db?.close();
    this.db = null;
    open.delete(this);
  }
}

/** Save every open database now (the window is closing). */
export function saveAll() {
  for (const d of open) if (d.timer) d.save();
}
rt.saveAll = saveAll;
export default { DatabaseSync };
