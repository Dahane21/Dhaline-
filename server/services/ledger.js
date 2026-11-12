'use strict';
// Motor contable de partida doble. Toda operación con efecto económico genera un asiento balanceado.
const { bad, r4 } = require('../lib');
const { nowIso } = require('../db');

const ACCOUNTS = [
  ['1101', 'Efectivo', 'activo', 1], ['1102', 'Yape', 'activo', 1], ['1103', 'Plin', 'activo', 1],
  ['1104', 'Banco / Transferencias', 'activo', 1], ['1105', 'Otros medios', 'activo', 1],
  ['1201', 'Cuentas por cobrar clientes (neto de adelantos)', 'activo', 0],
  ['1301', 'Inventario materia prima', 'activo', 0], ['1302', 'Inventario empaques', 'activo', 0],
  ['1303', 'Inventario suministros', 'activo', 0], ['1304', 'Inventario productos terminados', 'activo', 0],
  ['1305', 'Inventario presentaciones armadas', 'activo', 0],
  ['1401', 'Herramientas y activos', 'activo', 0],
  ['2101', 'Cuentas por pagar proveedores', 'pasivo', 0], ['2201', 'Préstamos por pagar', 'pasivo', 0],
  ['3101', 'Aportes de capital de socias', 'patrimonio', 0], ['3102', 'Retiros de socias', 'patrimonio', 0],
  ['3103', 'Saldos de apertura', 'patrimonio', 0],
  ['4101', 'Ventas de productos', 'ingreso', 0], ['4102', 'Ingresos por delivery cobrado', 'ingreso', 0],
  ['4103', 'Otros ingresos', 'ingreso', 0],
  ['4191', 'Descuentos sobre ventas', 'contra_ingreso', 0], ['4192', 'Devoluciones sobre ventas', 'contra_ingreso', 0],
  ['5101', 'Costo de ventas', 'costo', 0], ['5103', 'Mermas y ajustes de inventario', 'costo', 0],
  ['6101', 'Gastos operativos', 'gasto', 0], ['6102', 'Gastos administrativos', 'gasto', 0],
  ['6103', 'Gastos de marketing', 'gasto', 0], ['6104', 'Gastos de delivery', 'gasto', 0],
  ['6105', 'Comisiones de pago', 'gasto', 0], ['6106', 'Otros egresos', 'gasto', 0],
  ['6107', 'Mano de obra pagada', 'gasto', 0], ['6109', 'Gastos financieros (intereses)', 'gasto', 0],
  ['6190', 'MO y CIF imputados aplicados a producción', 'gasto', 0],
];

const MONEY = { '1101': 'Efectivo', '1102': 'Yape', '1103': 'Plin', '1104': 'Transferencia / banco', '1105': 'Otros medios' };
const EXPENSE_CATEGORIES = {
  operativo: '6101', administrativo: '6102', marketing: '6103', delivery: '6104',
  comisiones: '6105', otros: '6106', mano_obra: '6107', financiero: '6109',
};
const ITEM_ACCOUNT = { materia_prima: '1301', empaque: '1302', suministro: '1303' };

function seedAccounts(db) {
  ACCOUNTS.forEach(([code, name, type, money], i) => {
    db.run('INSERT OR IGNORE INTO accounts(code,name,type,money,sort) VALUES(?,?,?,?,?)', code, name, type, money, i);
  });
}

function checkMoney(code) { if (!MONEY[code]) throw bad('Seleccione una cuenta de dinero válida (efectivo, Yape, Plin, banco u otros).'); return code; }
function expenseAccount(cat) { const a = EXPENSE_CATEGORIES[cat]; if (!a) throw bad('Categoría de gasto inválida.'); return a; }

/**
 * Registra un asiento. lines: [{account, debit?, credit?, memo?}]. Se omiten líneas en cero.
 * Lanza error si no cuadra (protege contra doble conteo o descuadres).
 */
function post(db, ctx, { date, description, ref_type, ref_id, lines }) {
  const clean = [];
  for (const l of lines) {
    const d = r4(l.debit || 0), c = r4(l.credit || 0);
    if (Math.abs(d) < 1e-9 && Math.abs(c) < 1e-9) continue;
    // Montos negativos se invierten de lado para mantener el libro legible
    if (d < 0 || c < 0) clean.push({ account: l.account, debit: r4(Math.max(0, -c) + Math.max(0, d)), credit: r4(Math.max(0, -d) + Math.max(0, c)), memo: l.memo });
    else clean.push({ account: l.account, debit: d, credit: c, memo: l.memo });
  }
  if (!clean.length) return null;
  const td = clean.reduce((s, l) => s + l.debit, 0), tc = clean.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(td - tc) > 0.0005) throw new Error(`Asiento descuadrado (${description}): debe ${td} / haber ${tc}`);
  const entryId = db.insert('journal_entries', { date, description, ref_type, ref_id, created_at: nowIso(), user_id: ctx.user?.id });
  for (const l of clean) db.insert('journal_lines', { entry_id: entryId, account_code: l.account, debit: l.debit, credit: l.credit, memo: l.memo });
  return entryId;
}

/** Revierte todos los asientos vigentes de una referencia (anulaciones auditables, nunca borrado). */
function reverseRef(db, ctx, ref_type, ref_id, reason) {
  const entries = db.all('SELECT * FROM journal_entries WHERE ref_type=? AND ref_id=? AND reversed_by_id IS NULL AND reverses_id IS NULL', ref_type, ref_id);
  for (const e of entries) reverseEntry(db, ctx, e, reason);
}
function reverseEntry(db, ctx, e, reason) {
  const lines = db.all('SELECT * FROM journal_lines WHERE entry_id=?', e.id);
  const rid = db.insert('journal_entries', {
    date: e.date, description: `ANULACIÓN: ${e.description}${reason ? ' — ' + reason : ''}`, ref_type: e.ref_type, ref_id: e.ref_id,
    reverses_id: e.id, created_at: nowIso(), user_id: ctx.user?.id,
  });
  for (const l of lines) db.insert('journal_lines', { entry_id: rid, account_code: l.account_code, debit: l.credit, credit: l.debit, memo: l.memo });
  db.run('UPDATE journal_entries SET reversed_by_id=? WHERE id=?', rid, e.id);
  return rid;
}

/** Saldo (debe - haber) por cuenta, opcionalmente en rango de fechas. */
function balances(db, { from, to } = {}) {
  const where = []; const p = [];
  if (from) { where.push('e.date >= ?'); p.push(from); }
  if (to) { where.push('e.date <= ?'); p.push(to); }
  const rows = db.all(`SELECT l.account_code code, SUM(l.debit) d, SUM(l.credit) c FROM journal_lines l
    JOIN journal_entries e ON e.id=l.entry_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY l.account_code`, ...p);
  const out = {};
  for (const r of rows) out[r.code] = r4((r.d || 0) - (r.c || 0));
  return out;
}

function trialBalanceOk(db) {
  const r = db.get('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines');
  return Math.abs((r.d || 0) - (r.c || 0)) < 0.001;
}

module.exports = { ACCOUNTS, MONEY, EXPENSE_CATEGORIES, ITEM_ACCOUNT, seedAccounts, post, reverseRef, reverseEntry, balances, checkMoney, expenseAccount, trialBalanceOk };
