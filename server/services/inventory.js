'use strict';
// Inventario de insumos (materia prima, empaques, suministros) con costo promedio ponderado y kárdex.
const { bad, r2, r4, r6, EPS, V, today } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const { audit } = require('./audit');

const ITEM_TYPES = ['materia_prima', 'empaque', 'suministro'];

function getItem(db, id) {
  const it = db.get('SELECT * FROM items WHERE id=?', id);
  if (!it) throw bad('Insumo no encontrado.');
  return it;
}
function avgCost(it) { return it.stock_qty > EPS ? it.stock_value / it.stock_qty : (it.last_cost || 0); }

/** Precio vigente por unidad base: promedio si hay stock; si no, último precio de compra o referencia. */
function currentCost(db, itemId) {
  const it = getItem(db, itemId);
  if (it.stock_qty > EPS) return it.stock_value / it.stock_qty;
  return it.last_cost || 0;
}

/** Entrada al inventario. total_cost es el costo de las unidades que ingresan. */
function receive(db, ctx, { item_id, qty, total_cost, date, type = 'compra', ref_type, ref_id, note }) {
  const it = getItem(db, item_id);
  qty = Number(qty); total_cost = r6(total_cost);
  if (!(qty > 0)) throw bad(`${it.name}: la cantidad debe ser mayor que 0.`);
  if (total_cost < 0) throw bad(`${it.name}: el costo no puede ser negativo.`);
  const nq = r6(it.stock_qty + qty);
  let nv = r6(it.stock_value + total_cost);
  if (Math.abs(nq) < EPS) nv = 0;
  db.run('UPDATE items SET stock_qty=?, stock_value=? WHERE id=?', nq, nv, it.id);
  if (type === 'compra' || type === 'inicial') db.run('UPDATE items SET last_cost=? WHERE id=?', r6(total_cost / qty), it.id);
  return db.insert('inventory_movements', {
    item_id: it.id, date, type, qty, unit_cost: r6(total_cost / qty), total_cost, balance_qty: nq, balance_value: nv,
    ref_type, ref_id, note, created_at: nowIso(), user_id: ctx.user?.id,
  });
}

/**
 * Salida del inventario a costo promedio. Devuelve { cost, movement_id }.
 * No permite stock negativo salvo autorización explícita (ctx.allowNegative y rol admin).
 */
function consume(db, ctx, { item_id, qty, date, type = 'consumo', ref_type, ref_id, note, unit_cost }) {
  const it = getItem(db, item_id);
  qty = Number(qty);
  if (!(qty > 0)) throw bad(`${it.name}: la cantidad a descontar debe ser mayor que 0.`);
  if (qty > it.stock_qty + EPS) {
    if (!(ctx.allowNegative && ctx.user?.role === 'admin')) {
      throw bad(`Stock insuficiente de ${it.name}: disponible ${fmtQ(it.stock_qty)} ${it.base_unit}, se requieren ${fmtQ(qty)} ${it.base_unit}.`, { code: 'stock_negativo', item_id: it.id });
    }
  }
  let cost;
  const uc = unit_cost !== undefined ? unit_cost : avgCost(it);
  const nq = r6(it.stock_qty - qty);
  if (unit_cost === undefined && Math.abs(nq) < EPS) cost = it.stock_value; // vacía el saldo exacto, sin residuos
  else cost = r6(qty * uc);
  let nv = r6(it.stock_value - cost);
  if (Math.abs(nq) < EPS) { cost = r6(cost + nv); nv = 0; }
  db.run('UPDATE items SET stock_qty=?, stock_value=? WHERE id=?', nq, nv, it.id);
  const mid = db.insert('inventory_movements', {
    item_id: it.id, date, type, qty: -qty, unit_cost: r6(cost / qty), total_cost: -cost, balance_qty: nq, balance_value: nv,
    ref_type, ref_id, note, created_at: nowIso(), user_id: ctx.user?.id,
  });
  return { cost, movement_id: mid, item: it };
}

/** Revierte todos los movimientos de una referencia devolviendo/quitando unidades al costo original. */
function reverseMovements(db, ctx, ref_type, ref_id, note) {
  const movs = db.all("SELECT * FROM inventory_movements WHERE ref_type=? AND ref_id=? AND type NOT LIKE 'anulacion%' ORDER BY id DESC", ref_type, ref_id);
  const byAccount = {};
  for (const m of movs) {
    const it = getItem(db, m.item_id);
    const acc = L.ITEM_ACCOUNT[it.type];
    if (m.qty > 0) {
      // Fue una entrada: retirar la misma cantidad al costo de ingreso
      if (it.stock_qty + EPS < m.qty) throw bad(`No se puede anular: ${it.name} ya fue consumido (disponible ${fmtQ(it.stock_qty)}, ingresaron ${fmtQ(m.qty)}). Registre un ajuste en su lugar.`);
      const r = consume(db, ctx, { item_id: it.id, qty: m.qty, date: m.date, type: 'anulacion_entrada', ref_type, ref_id, note, unit_cost: m.unit_cost });
      byAccount[acc] = (byAccount[acc] || 0) - r.cost;
    } else {
      receive(db, ctx, { item_id: it.id, qty: -m.qty, total_cost: -m.total_cost, date: m.date, type: 'anulacion_salida', ref_type, ref_id, note });
      byAccount[acc] = (byAccount[acc] || 0) + (-m.total_cost);
    }
  }
  return byAccount;
}

function fmtQ(q) { return Math.round(q * 1000) / 1000; }

// ---------- CRUD de insumos ----------
function saveItem(db, ctx, b, id) {
  const data = {
    name: V.str(b.name, 'Nombre', { max: 120 }),
    type: V.oneOf(b.type, 'Tipo', ITEM_TYPES),
    category: V.str(b.category, 'Categoría', { optional: true }),
    base_unit: V.oneOf(b.base_unit, 'Unidad base', ['g', 'ml', 'und', 'm']),
    pres_label: V.str(b.pres_label, 'Presentación', { optional: true }),
    pres_size: V.num(b.pres_size, 'Tamaño de presentación', { optional: true, gt: 0 }),
    min_stock: V.num(b.min_stock ?? 0, 'Stock mínimo', { min: 0 }),
    aliases: V.str(b.aliases, 'Alias', { optional: true }),
    notes: V.str(b.notes, 'Notas', { optional: true, max: 1000 }),
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
  return db.tx(() => {
    if (id) {
      const old = getItem(db, id);
      if (old.base_unit !== data.base_unit && db.get('SELECT 1 FROM inventory_movements WHERE item_id=? LIMIT 1', id)) {
        throw bad('No se puede cambiar la unidad base de un insumo con movimientos.');
      }
      db.update('items', id, data);
      // Cambio de tipo con saldo: se reclasifica el valor entre cuentas de inventario (asiento auditable)
      if (old.type !== data.type && Math.abs(old.stock_value) > 0.00005) {
        L.post(db, ctx, { date: today(), description: `Reclasificación de ${old.name}: ${old.type} → ${data.type}`, ref_type: 'reclasificacion', ref_id: id,
          lines: [{ account: L.ITEM_ACCOUNT[data.type], debit: old.stock_value }, { account: L.ITEM_ACCOUNT[old.type], credit: old.stock_value }] });
      }
      audit(db, ctx, 'editar', 'insumo', id, data);
      return id;
    }
    const newId = db.insert('items', { ...data, created_at: nowIso(), is_demo: b.is_demo ? 1 : 0 });
    const ref = V.num(b.ref_price, 'Precio de referencia', { optional: true, min: 0 });
    if (ref !== null && ref > 0) {
      const size = data.pres_size || 1;
      setReferencePrice(db, ctx, newId, { price: ref, size, label: data.pres_label, date: b.ref_date || today() });
    }
    audit(db, ctx, 'crear', 'insumo', newId, data);
    return newId;
  });
}

/** Precio de referencia histórico (no genera stock ni dinero). */
function setReferencePrice(db, ctx, itemId, { price, size, label, date, note }) {
  const unit = r6(price / size);
  db.insert('item_prices', { item_id: itemId, date, unit_cost: unit, source: 'referencia', pres_label: label, pres_price: price, note });
  const it = getItem(db, itemId);
  if (it.stock_qty <= EPS) db.run('UPDATE items SET last_cost=? WHERE id=?', unit, itemId);
}

// ---------- Consumo directo (fuera de producción/armado) ----------
function directConsumption(db, ctx, b) {
  const date = V.date(b.date);
  const item_id = V.id(b.item_id, 'Insumo');
  const qty = V.num(b.qty, 'Cantidad', { gt: 0 });
  const destination = V.oneOf(b.destination, 'Destino', ['gasto', 'merma']);
  const cat = destination === 'gasto' ? V.oneOf(b.expense_category || 'operativo', 'Categoría', Object.keys(L.EXPENSE_CATEGORIES)) : null;
  return db.tx(() => {
    const id = db.insert('item_consumptions', { date, item_id, qty, cost: 0, destination, expense_category: cat, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id, is_demo: b.is_demo ? 1 : 0 });
    const r = consume(db, { ...ctx, allowNegative: !!b.allow_negative }, { item_id, qty, date, type: destination === 'merma' ? 'merma' : 'consumo_directo', ref_type: 'consumo', ref_id: id, note: b.notes });
    db.update('item_consumptions', id, { cost: r.cost });
    L.post(db, ctx, {
      date, description: `${destination === 'merma' ? 'Merma' : 'Consumo directo'}: ${r.item.name} (${qty} ${r.item.base_unit})`, ref_type: 'consumo', ref_id: id,
      lines: [{ account: destination === 'merma' ? '5103' : L.expenseAccount(cat), debit: r.cost }, { account: L.ITEM_ACCOUNT[r.item.type], credit: r.cost }],
    });
    audit(db, ctx, 'crear', 'consumo_directo', id, b);
    return id;
  });
}
function annulConsumption(db, ctx, id, reason) {
  return db.tx(() => {
    const c = db.get('SELECT * FROM item_consumptions WHERE id=?', id);
    if (!c || c.status !== 'activo') throw bad('Consumo no encontrado o ya anulado.');
    reverseMovements(db, ctx, 'consumo', id, 'Anulación');
    L.reverseRef(db, ctx, 'consumo', id, reason);
    db.update('item_consumptions', id, { status: 'anulado', annul_reason: reason || null });
    audit(db, ctx, 'anular', 'consumo_directo', id, { reason });
  });
}

// ---------- Conteo físico (ajuste auditable) ----------
function physicalCount(db, ctx, b) {
  const date = V.date(b.date);
  const item_id = V.id(b.item_id, 'Insumo');
  const counted = V.num(b.counted_qty, 'Cantidad contada', { min: 0 });
  return db.tx(() => {
    const it = getItem(db, item_id);
    const diff = r6(counted - it.stock_qty);
    const cid = db.insert('inventory_counts', { date, item_id, system_qty: it.stock_qty, counted_qty: counted, diff_qty: diff, diff_value: 0, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id });
    let value = 0;
    const acc = L.ITEM_ACCOUNT[it.type];
    if (diff < -EPS) {
      const r = consume(db, { ...ctx, allowNegative: true, user: { ...ctx.user, role: 'admin' } }, { item_id, qty: -diff, date, type: 'ajuste_faltante', ref_type: 'conteo', ref_id: cid, note: b.notes });
      value = -r.cost;
      L.post(db, ctx, { date, description: `Ajuste por conteo físico (faltante): ${it.name}`, ref_type: 'conteo', ref_id: cid, lines: [{ account: '5103', debit: r.cost }, { account: acc, credit: r.cost }] });
    } else if (diff > EPS) {
      const uc = avgCost(it);
      value = r6(diff * uc);
      receive(db, ctx, { item_id, qty: diff, total_cost: value, date, type: 'ajuste_sobrante', ref_type: 'conteo', ref_id: cid, note: b.notes });
      L.post(db, ctx, { date, description: `Ajuste por conteo físico (sobrante): ${it.name}`, ref_type: 'conteo', ref_id: cid, lines: [{ account: acc, debit: value }, { account: '5103', credit: value }] });
    }
    db.update('inventory_counts', cid, { diff_value: value });
    audit(db, ctx, 'crear', 'conteo_fisico', cid, { item: it.name, system: it.stock_qty, counted, diff });
    return { id: cid, diff, value };
  });
}

// ---------- Inventario inicial (saldos de apertura) ----------
function openingItem(db, ctx, b) {
  const date = V.date(b.date);
  const item_id = V.id(b.item_id, 'Insumo');
  const qty = V.num(b.qty, 'Cantidad', { gt: 0 });
  const total = V.num(b.total_cost, 'Valor total', { min: 0 });
  return db.tx(() => {
    const it = getItem(db, item_id);
    const mid = receive(db, ctx, { item_id, qty, total_cost: total, date, type: 'inicial', ref_type: 'apertura', ref_id: null, note: b.notes || 'Inventario inicial' });
    db.run('UPDATE inventory_movements SET ref_id=? WHERE id=?', mid, mid);
    L.post(db, ctx, { date, description: `Inventario inicial: ${it.name}`, ref_type: 'apertura', ref_id: mid, lines: [{ account: L.ITEM_ACCOUNT[it.type], debit: total }, { account: '3103', credit: total }] });
    audit(db, ctx, 'crear', 'inventario_inicial', mid, b);
    return mid;
  });
}

function listItems(db) {
  return db.all('SELECT * FROM items ORDER BY active DESC, type, name').map(it => ({
    ...it, avg_cost: avgCost(it),
    ref_price: db.get("SELECT unit_cost, pres_label, pres_price, date FROM item_prices WHERE item_id=? ORDER BY date DESC, id DESC LIMIT 1", it.id),
  }));
}
function kardex(db, itemId) {
  return {
    item: getItem(db, itemId),
    movements: db.all('SELECT m.*, u.username FROM inventory_movements m LEFT JOIN users u ON u.id=m.user_id WHERE item_id=? ORDER BY m.id', itemId),
    prices: db.all('SELECT * FROM item_prices WHERE item_id=? ORDER BY date, id', itemId),
  };
}

module.exports = { ITEM_TYPES, getItem, avgCost, currentCost, receive, consume, reverseMovements, saveItem, setReferencePrice, directConsumption, annulConsumption, physicalCount, openingItem, listItems, kardex };
