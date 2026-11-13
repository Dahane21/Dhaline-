'use strict';
// Misma interfaz que server/db.js, pero sobre sql.js (SQLite compilado a JavaScript) para correr dentro del navegador.
const { SCHEMA } = require('./schema');

function nowIso() { return new Date().toISOString(); }
function norm(v) { if (v === undefined) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }

class Db {
  constructor(SQL, bytes) {
    this.conn = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.conn.exec('PRAGMA foreign_keys = ON;');
    this.conn.exec(SCHEMA);
    this.depth = 0;
    this.cache = new Map();
    if (!this.get("SELECT value FROM settings WHERE key='schema_version'")) this.run("INSERT INTO settings(key,value) VALUES('schema_version','1')");
  }
  stmt(sql) { let s = this.cache.get(sql); if (!s) { s = this.conn.prepare(sql); this.cache.set(sql, s); } return s; }
  all(sql, ...p) {
    const s = this.stmt(sql); s.bind(p.map(norm)); const out = [];
    try { while (s.step()) out.push(s.getAsObject()); } finally { s.reset(); }
    return out;
  }
  get(sql, ...p) {
    const s = this.stmt(sql); s.bind(p.map(norm));
    try { return s.step() ? s.getAsObject() : null; } finally { s.reset(); }
  }
  run(sql, ...p) {
    const s = this.stmt(sql); s.bind(p.map(norm));
    try { s.step(); } finally { s.reset(); }
    const id = this.conn.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { id: Number(id), changes: this.conn.getRowsModified() };
  }
  insert(table, obj) {
    const keys = Object.keys(obj);
    return this.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => obj[k])).id;
  }
  update(table, id, obj) {
    const keys = Object.keys(obj); if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => obj[k]), id);
  }
  tx(fn) {
    if (this.depth > 0) {
      const sp = 'sp' + this.depth; this.conn.exec('SAVEPOINT ' + sp); this.depth++;
      try { const r = fn(); this.depth--; this.conn.exec('RELEASE ' + sp); return r; }
      catch (e) { this.depth--; this.conn.exec('ROLLBACK TO ' + sp + '; RELEASE ' + sp); throw e; }
    }
    this.conn.exec('BEGIN'); this.depth = 1;
    try { const r = fn(); this.conn.exec('COMMIT'); this.depth = 0; return r; }
    catch (e) { this.depth = 0; try { this.conn.exec('ROLLBACK'); } catch { /* ya revertida */ } throw e; }
  }
  setting(key, def = null) { const r = this.get('SELECT value FROM settings WHERE key=?', key); return r ? r.value : def; }
  setSetting(key, value) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
  export() { for (const s of this.cache.values()) s.free(); this.cache.clear(); const b = this.conn.export(); this.conn.exec('PRAGMA foreign_keys = ON;'); return b; }
  close() { this.conn.close(); }
}
module.exports = { Db, nowIso };
