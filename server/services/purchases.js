'use strict';
// Compras: ingresan a inventario (no son gasto), a activos o a gasto directo, sin duplicar costos.
const { bad, r2, r6, V, unitFactor } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const INV = require('./inventory');
const { audit } = require('./audit');

function nextCode(db, table, prefix) {
  const r = db.get(`SELECT COUNT(*) n FROM ${table}`);
  return `${prefix}-${String(r.n + 1).padStart(4, '0')}`;
}

function createPurchase(db, ctx, b) {
  const date = V.date(b.date);
  const pay_status = V.oneOf(b.pay_status || 'pagado', 'Estado de pago', ['pagado', 'credito']);
  const account = pay_status === 'pagado' ? L.checkMoney(b.account_code) : null;
  const supplier_id = V.optId(b.supplier_id);
  if (pay_status === 'credito' && !supplier_id) throw bad('Para una compra al crédito indique el proveedor.');
  const lines = V.arr(b.lines, 'Productos comprados');

  return db.tx(() => {
    const pid = db.insert('purchases', {
      code: nextCode(db, 'purchases', 'C'), date, supplier_id, pay_status, account_code: account,
      voucher_type: b.voucher_type || null, voucher_number: b.voucher_number || null, notes: b.notes || null,
      total: 0, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id,
    });
    let total = 0;
    const debits = {};
    lines.forEach((ln, i) => {
      const n = `Línea ${i + 1}`;
      const kind = V.oneOf(ln.kind || 'inventario', `${n}: tipo`, ['inventario', 'activo', 'gasto']);
      const qty = V.num(ln.qty, `${n}: cantidad`, { gt: 0 });
      // Se acepta precio unitario o importe total; si llegan ambos deben ser coherentes.
      let lineTotal = ln.total !== undefined && ln.total !== '' && ln.total !== null ? V.num(ln.total, `${n}: importe`, { min: 0 }) : null;
      let unitPrice = ln.unit_price !== undefined && ln.unit_price !== '' && ln.unit_price !== null ? V.num(ln.unit_price, `${n}: precio unitario`, { min: 0 }) : null;
      if (lineTotal === null && unitPrice === null) throw bad(`${n}: indique el precio unitario o el importe total.`);
      if (lineTotal === null) lineTotal = r2(unitPrice * qty);
      if (unitPrice === null) unitPrice = r6(lineTotal / qty);
      if (Math.abs(r2(unitPrice * qty) - lineTotal) > 0.05) throw bad(`${n}: precio unitario × cantidad (${r2(unitPrice * qty)}) no coincide con el importe (${lineTotal}).`);
      lineTotal = r2(lineTotal);
      total += lineTotal;
      const row = { purchase_id: pid, kind, qty, unit_price: unitPrice, total: lineTotal, description: ln.description || null, category: ln.category || null };

      if (kind === 'inventario') {
        const it = INV.getItem(db, V.id(ln.item_id, `${n}: insumo`));
        const unit = ln.unit || it.base_unit;
        const factor = unitFactor(it, unit);
        const base_qty = r6(qty * factor);
        const lid = db.insert('purchase_lines', { ...row, item_id: it.id, unit, factor, base_qty, description: row.description || it.name });
        INV.receive(db, ctx, { item_id: it.id, qty: base_qty, total_cost: lineTotal, date, type: 'compra', ref_type: 'compra', ref_id: pid, note: `${qty} ${unit}` });
        db.insert('item_prices', { item_id: it.id, date, unit_cost: r6(lineTotal / base_qty), source: 'compra', supplier_id, purchase_line_id: lid, pres_label: `${qty} ${unit}`, pres_price: lineTotal });
        const acc = L.ITEM_ACCOUNT[it.type];
        debits[acc] = (debits[acc] || 0) + lineTotal;
      } else if (kind === 'activo') {
        const name = V.str(ln.description, `${n}: descripción del activo`);
        const lid = db.insert('purchase_lines', { ...row, unit: ln.unit || 'und', factor: 1, base_qty: qty, description: name });
        const aid = db.insert('assets', { name, category: ln.category || 'Herramientas y utensilios', qty, unit_cost: unitPrice, total_cost: lineTotal, date, capacity: ln.capacity || null, purchase_line_id: lid, is_demo: b.is_demo ? 1 : 0 });
        db.update('purchase_lines', lid, { asset_id: aid });
        debits['1401'] = (debits['1401'] || 0) + lineTotal;
      } else {
        const cat = V.oneOf(ln.expense_category || 'operativo', `${n}: categoría de gasto`, Object.keys(L.EXPENSE_CATEGORIES));
        const name = V.str(ln.description, `${n}: descripción`);
        db.insert('purchase_lines', { ...row, unit: ln.unit || 'und', factor: 1, base_qty: qty, description: name, expense_category: cat });
        const acc = L.expenseAccount(cat);
        debits[acc] = (debits[acc] || 0) + lineTotal;
      }
    });
    total = r2(total);
    db.update('purchases', pid, { total });
    const sup = supplier_id ? db.get('SELECT name FROM suppliers WHERE id=?', supplier_id) : null;
    L.post(db, ctx, {
      date, description: `Compra ${sup ? 'a ' + sup.name : ''}`.trim(), ref_type: 'compra', ref_id: pid,
      lines: [...Object.entries(debits).map(([account, v]) => ({ account, debit: v })), { account: account || '2101', credit: total }],
    });
    audit(db, ctx, 'crear', 'compra', pid, b);
    return pid;
  });
}

function annulPurchase(db, ctx, id, reason) {
  return db.tx(() => {
    const p = db.get('SELECT * FROM purchases WHERE id=?', id);
    if (!p || p.status !== 'activa') throw bad('Compra no encontrada o ya anulada.');
    if (!reason) throw bad('Indique el motivo de la anulación.');
    const byAcc = INV.reverseMovements(db, ctx, 'compra', id, 'Anulación de compra');
    // Si el inventario se retiró por un valor distinto al original (por redondeo/saldo cero), la diferencia va a ajustes
    const lines = db.all('SELECT * FROM purchase_lines WHERE purchase_id=?', id);
    L.reverseRef(db, ctx, 'compra', id, reason);
    const expected = {};
    for (const ln of lines) if (ln.kind === 'inventario') { const it = INV.getItem(db, ln.item_id); const a = L.ITEM_ACCOUNT[it.type]; expected[a] = (expected[a] || 0) + ln.total; }
    const adj = [];
    for (const [acc, v] of Object.entries(expected)) {
      const removed = -(byAcc[acc] || 0); const d = r6(removed - v);
      if (Math.abs(d) > 0.00005) adj.push({ account: acc, credit: d }, { account: '5103', debit: d });
    }
    if (adj.length) L.post(db, ctx, { date: p.date, description: `Ajuste de valorización por anulación de compra ${p.code}`, ref_type: 'compra_ajuste', ref_id: id, lines: adj });
    for (const ln of lines) if (ln.asset_id) db.update('assets', ln.asset_id, { status: 'anulado' });
    db.update('purchases', id, { status: 'anulada', annul_reason: reason });
    audit(db, ctx, 'anular', 'compra', id, { reason });
  });
}

function listPurchases(db, { from, to } = {}) {
  const w = []; const p = [];
  if (from) { w.push('p.date>=?'); p.push(from); } if (to) { w.push('p.date<=?'); p.push(to); }
  const rows = db.all(`SELECT p.*, s.name supplier FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.date DESC, p.id DESC`, ...p);
  for (const r of rows) r.lines = db.all('SELECT pl.*, i.name item_name, i.base_unit FROM purchase_lines pl LEFT JOIN items i ON i.id=pl.item_id WHERE purchase_id=?', r.id);
  return rows;
}

// Pagos a proveedores (cancelan cuentas por pagar)
function paySupplier(db, ctx, b) {
  const date = V.date(b.date); const amount = V.num(b.amount, 'Monto', { gt: 0 }); const acc = L.checkMoney(b.account_code);
  const supplier_id = V.id(b.supplier_id, 'Proveedor');
  return db.tx(() => {
    const id = db.insert('supplier_payments', { supplier_id, date, amount, account_code: acc, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id, is_demo: b.is_demo ? 1 : 0 });
    const s = db.get('SELECT name FROM suppliers WHERE id=?', supplier_id);
    L.post(db, ctx, { date, description: `Pago a proveedor ${s?.name || ''}`, ref_type: 'pago_proveedor', ref_id: id, lines: [{ account: '2101', debit: amount }, { account: acc, credit: amount }] });
    audit(db, ctx, 'crear', 'pago_proveedor', id, b);
    return id;
  });
}

module.exports = { createPurchase, annulPurchase, listPurchases, paySupplier, nextCode };
