'use strict';
// Capa de base de datos: SQLite embebido (node:sqlite), transacciones y esquema.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operador','lectura')),
  pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, username TEXT,
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, detail TEXT);

-- Plan de cuentas y libro diario (partida doble)
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('activo','pasivo','patrimonio','ingreso','contra_ingreso','costo','gasto')),
  money INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL,
  ref_type TEXT NOT NULL, ref_id INTEGER, reverses_id INTEGER, reversed_by_id INTEGER,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_je_ref ON journal_entries(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS ix_je_date ON journal_entries(date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, memo TEXT);
CREATE INDEX IF NOT EXISTS ix_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jl_acc ON journal_lines(account_code);

-- Maestros
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, doc TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('materia_prima','empaque','suministro')),
  category TEXT, base_unit TEXT NOT NULL CHECK (base_unit IN ('g','ml','und','m')),
  pres_label TEXT, pres_size REAL, min_stock REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0, stock_value REAL NOT NULL DEFAULT 0,
  last_cost REAL NOT NULL DEFAULT 0, aliases TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS item_prices (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), date TEXT NOT NULL,
  unit_cost REAL NOT NULL, source TEXT NOT NULL, supplier_id INTEGER, purchase_line_id INTEGER,
  pres_label TEXT, pres_price REAL, note TEXT);
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), date TEXT NOT NULL,
  type TEXT NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL, total_cost REAL NOT NULL,
  balance_qty REAL NOT NULL, balance_value REAL NOT NULL, ref_type TEXT, ref_id INTEGER,
  note TEXT, created_at TEXT NOT NULL, user_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_im_item ON inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS ix_im_ref ON inventory_movements(ref_type, ref_id);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, qty REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, date TEXT NOT NULL,
  capacity TEXT, purchase_line_id INTEGER, status TEXT NOT NULL DEFAULT 'activo', notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0);

-- Compras
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, date TEXT NOT NULL, supplier_id INTEGER REFERENCES suppliers(id),
  pay_status TEXT NOT NULL CHECK (pay_status IN ('pagado','credito')), account_code TEXT,
  voucher_type TEXT, voucher_number TEXT, notes TEXT, total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'activa', annul_reason TEXT, opening INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  kind TEXT NOT NULL CHECK (kind IN ('inventario','activo','gasto')),
  item_id INTEGER REFERENCES items(id), description TEXT, category TEXT,
  qty REAL NOT NULL, unit TEXT NOT NULL, factor REAL NOT NULL DEFAULT 1, base_qty REAL NOT NULL,
  unit_price REAL NOT NULL, total REAL NOT NULL, expense_category TEXT, asset_id INTEGER);

-- Productos, calidades, recetas
CREATE TABLE IF NOT EXISTS quality_categories (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  sellable INTEGER NOT NULL DEFAULT 1, cost_factor REAL NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, family TEXT, shelf_life_days INTEGER NOT NULL DEFAULT 15,
  aliases TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS product_prices (
  product_id INTEGER NOT NULL REFERENCES products(id), quality_id INTEGER NOT NULL REFERENCES quality_categories(id),
  price REAL NOT NULL, PRIMARY KEY (product_id, quality_id));
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, quality_id INTEGER,
  price REAL NOT NULL, date TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  yield_qty REAL NOT NULL, labor_minutes REAL NOT NULL DEFAULT 0, labor_cost REAL NOT NULL DEFAULT 0,
  overhead_cost REAL NOT NULL DEFAULT 0, notes TEXT, active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY, recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL);

-- Producción
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, date TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  recipe_id INTEGER, qty_produced REAL NOT NULL, minutes REAL NOT NULL DEFAULT 0,
  materials_cost REAL NOT NULL DEFAULT 0, labor_cost REAL NOT NULL DEFAULT 0, overhead_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0, theoretical_cost REAL, allocation_method TEXT NOT NULL,
  expiry_date TEXT, kind TEXT NOT NULL DEFAULT 'produccion', campaign_id INTEGER,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS batch_consumptions (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, std_qty REAL, cost REAL NOT NULL, movement_id INTEGER);
CREATE TABLE IF NOT EXISTS batch_outputs (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id),
  quality_id INTEGER NOT NULL REFERENCES quality_categories(id), qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fg_lots (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id), product_id INTEGER NOT NULL REFERENCES products(id),
  quality_id INTEGER NOT NULL REFERENCES quality_categories(id), date TEXT NOT NULL, expiry_date TEXT,
  qty_initial REAL NOT NULL, qty_available REAL NOT NULL, unit_cost REAL NOT NULL, origin_lot_id INTEGER);
CREATE TABLE IF NOT EXISTS fg_movements (
  id INTEGER PRIMARY KEY, lot_id INTEGER NOT NULL REFERENCES fg_lots(id), date TEXT NOT NULL, type TEXT NOT NULL,
  qty REAL NOT NULL, unit_cost REAL NOT NULL, ref_type TEXT, ref_id INTEGER, note TEXT, created_at TEXT NOT NULL, user_id INTEGER);

-- Presentaciones y armado
CREATE TABLE IF NOT EXISTS presentations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, quality_id INTEGER NOT NULL REFERENCES quality_categories(id),
  price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, aliases TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS presentation_components (
  id INTEGER PRIMARY KEY, presentation_id INTEGER NOT NULL REFERENCES presentations(id),
  kind TEXT NOT NULL CHECK (kind IN ('producto','empaque')), product_id INTEGER, item_id INTEGER, qty REAL NOT NULL);
CREATE TABLE IF NOT EXISTS assemblies (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, date TEXT NOT NULL, presentation_id INTEGER NOT NULL REFERENCES presentations(id),
  qty REAL NOT NULL, unit_cost REAL NOT NULL, total_cost REAL NOT NULL, sale_id INTEGER,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, notes TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS assembly_consumptions (
  id INTEGER PRIMARY KEY, assembly_id INTEGER NOT NULL REFERENCES assemblies(id),
  source TEXT NOT NULL CHECK (source IN ('fg','item')), fg_lot_id INTEGER, item_id INTEGER, qty REAL NOT NULL, cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pack_lots (
  id INTEGER PRIMARY KEY, assembly_id INTEGER NOT NULL REFERENCES assemblies(id), presentation_id INTEGER NOT NULL,
  date TEXT NOT NULL, expiry_date TEXT, qty_initial REAL NOT NULL, qty_available REAL NOT NULL, unit_cost REAL NOT NULL);

-- Clientes, campañas, ventas
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, district TEXT, channel TEXT, notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT, end_date TEXT, notes TEXT, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL, date TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id),
  channel TEXT, campaign_id INTEGER REFERENCES campaigns(id),
  status TEXT NOT NULL CHECK (status IN ('pendiente','preparacion','listo','entregado','cancelado')),
  discount REAL NOT NULL DEFAULT 0, delivery_charge REAL NOT NULL DEFAULT 0, delivery_cost REAL NOT NULL DEFAULT 0,
  delivery_account TEXT, delivery_expense_id INTEGER, subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0, fulfilled INTEGER NOT NULL DEFAULT 0, fulfilled_at TEXT, delivered_at TEXT,
  notes TEXT, cancel_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS sale_lines (
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
  kind TEXT NOT NULL CHECK (kind IN ('producto','presentacion')),
  product_id INTEGER, quality_id INTEGER, presentation_id INTEGER, qty REAL NOT NULL,
  unit_price REAL NOT NULL, list_price REAL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
  cost_total REAL NOT NULL DEFAULT 0, returned_qty REAL NOT NULL DEFAULT 0, fill TEXT);
CREATE TABLE IF NOT EXISTS sale_allocations (
  id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL REFERENCES sale_lines(id),
  source TEXT NOT NULL CHECK (source IN ('fg','pack')), lot_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sale_cost_details (
  id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL REFERENCES sale_lines(id),
  product_id INTEGER, quality_id INTEGER, batch_id INTEGER, fg_lot_id INTEGER, item_id INTEGER,
  qty REAL NOT NULL, cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sale_payments (
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), date TEXT NOT NULL,
  amount REAL NOT NULL, account_code TEXT NOT NULL, commission REAL NOT NULL DEFAULT 0, notes TEXT,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS sale_returns (
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), line_id INTEGER NOT NULL REFERENCES sale_lines(id),
  date TEXT NOT NULL, qty REAL NOT NULL, amount REAL NOT NULL, restock INTEGER NOT NULL, cost REAL NOT NULL,
  notes TEXT, created_at TEXT NOT NULL, user_id INTEGER);

-- Finanzas
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  amount REAL NOT NULL, pay_status TEXT NOT NULL CHECK (pay_status IN ('pagado','pendiente')),
  account_code TEXT, supplier_id INTEGER, campaign_id INTEGER, sale_id INTEGER, voucher TEXT,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY, supplier_id INTEGER, date TEXT NOT NULL, amount REAL NOT NULL,
  account_code TEXT NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS capital_moves (
  id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL REFERENCES partners(id), date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('aporte','retiro')), amount REAL NOT NULL, account_code TEXT NOT NULL,
  notes TEXT, status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY, lender TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, account_code TEXT NOT NULL,
  notes TEXT, status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS loan_payments (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), date TEXT NOT NULL,
  principal REAL NOT NULL, interest REAL NOT NULL DEFAULT 0, account_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, from_account TEXT NOT NULL, to_account TEXT NOT NULL,
  amount REAL NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS item_consumptions (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL,
  cost REAL NOT NULL, destination TEXT NOT NULL, expense_category TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'activo', annul_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS inventory_counts (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, item_id INTEGER, fg_lot_id INTEGER,
  system_qty REAL NOT NULL, counted_qty REAL NOT NULL, diff_qty REAL NOT NULL, diff_value REAL NOT NULL,
  notes TEXT, created_at TEXT NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY, category TEXT NOT NULL, month TEXT NOT NULL, amount REAL NOT NULL, UNIQUE(category, month));
CREATE TABLE IF NOT EXISTS fixed_costs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, monthly_amount REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0);
`;

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
