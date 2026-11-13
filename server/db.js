'use strict';
// Capa de base de datos: SQLite embebido (node:sqlite), transacciones y esquema.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

const { SCHEMA } = require('./schema');

function nowIso() { return new Date().toISOString(); }

class Db {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.conn = new DatabaseSync(file);
    this.conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.conn.exec(SCHEMA);
    this.depth = 0;
    this.cache = new Map();
    const v = this.get("SELECT value FROM settings WHERE key='schema_version'");
    if (!v) this.run("INSERT INTO settings(key,value) VALUES('schema_version',?)", String(SCHEMA_VERSION));
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.conn.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  all(sql, ...p) { return this.stmt(sql).all(...p).map(plain); }
  get(sql, ...p) { const r = this.stmt(sql).get(...p); return r ? plain(r) : null; }
  run(sql, ...p) { const r = this.stmt(sql).run(...p); return { id: Number(r.lastInsertRowid), changes: Number(r.changes) }; }
  insert(table, obj) {
    const keys = Object.keys(obj);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return this.run(sql, ...keys.map(k => norm(obj[k]))).id;
  }
  update(table, id, obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => norm(obj[k])), id);
  }
  // Transacción anidable: toda operación de negocio corre dentro de tx(); si algo falla, ROLLBACK total.
  tx(fn) {
    if (this.depth > 0) {
      const sp = 'sp' + this.depth;
      this.conn.exec('SAVEPOINT ' + sp); this.depth++;
      try { const r = fn(); this.depth--; this.conn.exec('RELEASE ' + sp); return r; }
      catch (e) { this.depth--; this.conn.exec('ROLLBACK TO ' + sp + '; RELEASE ' + sp); throw e; }
    }
    this.conn.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const r = fn(); this.conn.exec('COMMIT'); this.depth = 0; return r; }
    catch (e) { this.depth = 0; try { this.conn.exec('ROLLBACK'); } catch {} throw e; }
  }
  setting(key, def = null) { const r = this.get('SELECT value FROM settings WHERE key=?', key); return r ? r.value : def; }
  setSetting(key, value) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
  backupTo(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.conn.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }
  close() { this.conn.close(); }
}
function norm(v) { if (v === undefined) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }
function plain(r) { const o = {}; for (const k in r) { const v = r[k]; o[k] = typeof v === 'bigint' ? Number(v) : v; } return o; }

module.exports = { Db, nowIso };
