'use strict';
// Producción, fichas técnicas (recetas), control de calidad y lotes de producto terminado.
const { bad, r2, r6, EPS, V, addDays } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const INV = require('./inventory');
const { audit } = require('./audit');

const ALLOCATION_METHODS = {
  igual: 'Costo igual por unidad comercializable',
  factor: 'Ponderado por factor de costo de cada calidad',
  valor_venta: 'Proporcional al valor de venta (valor neto realizable)',
};

function qualities(db) { return db.all('SELECT * FROM quality_categories ORDER BY sort, id'); }
function priceOf(db, productId, qualityId) { const r = db.get('SELECT price FROM product_prices WHERE product_id=? AND quality_id=?', productId, qualityId); return r ? r.price : 0; }

// ---------- Fichas técnicas ----------
function recipeCost(db, recipeId, qty) {
  const rc = db.get('SELECT * FROM recipes WHERE id=?', recipeId);
  if (!rc) throw bad('Receta no encontrada.');
  const scale = qty ? qty / rc.yield_qty : 1;
  const lines = db.all('SELECT rl.*, i.name, i.base_unit, i.type FROM recipe_lines rl JOIN items i ON i.id=rl.item_id WHERE recipe_id=?', recipeId)
    .map(l => { const uc = INV.currentCost(db, l.item_id); return { ...l, qty_scaled: r6(l.qty * scale), unit_cost: uc, cost: r6(l.qty * scale * uc) }; });
  const materials = lines.reduce((s, l) => s + l.cost, 0);
  const labor = rc.labor_cost * scale, overhead = rc.overhead_cost * scale;
  const total = materials + labor + overhead;
  const units = qty || rc.yield_qty;
  return { recipe: rc, lines, materials: r6(materials), labor: r6(labor), overhead: r6(overhead), total: r6(total), units, unit_cost: r6(total / units) };
}

function saveRecipe(db, ctx, b, id) {
  const data = {
    name: V.str(b.name, 'Nombre'), product_id: V.id(b.product_id, 'Producto'),
    yield_qty: V.num(b.yield_qty, 'Rendimiento (unidades)', { gt: 0 }),
    labor_minutes: V.num(b.labor_minutes || 0, 'Minutos', { min: 0 }), labor_cost: V.num(b.labor_cost || 0, 'Mano de obra', { min: 0 }),
    overhead_cost: V.num(b.overhead_cost || 0, 'Costos indirectos', { min: 0 }), notes: b.notes || null,
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
  const lines = V.arr(b.lines, 'Ingredientes').map((l, i) => ({ item_id: V.id(l.item_id, `Ingrediente ${i + 1}`), qty: V.num(l.qty, `Ingrediente ${i + 1}: cantidad`, { gt: 0 }) }));
  return db.tx(() => {
    let rid = id;
    if (id) { db.update('recipes', id, data); db.run('DELETE FROM recipe_lines WHERE recipe_id=?', id); }
    else rid = db.insert('recipes', { ...data, is_demo: b.is_demo ? 1 : 0 });
    for (const l of lines) db.insert('recipe_lines', { recipe_id: rid, ...l });
    audit(db, ctx, id ? 'editar' : 'crear', 'receta', rid, { ...data, lines });
    return rid;
  });
}

// ---------- Asignación de costos entre calidades ----------
/**
 * Distribuye el costo total del lote entre las unidades comercializables.
 * Las no comercializables no reciben costo propio: su costo se absorbe (merma normal).
 */
function allocate(db, { total, product_id, outputs, method }) {
  const qmap = Object.fromEntries(qualities(db).map(q => [q.id, q]));
  const sellable = outputs.filter(o => qmap[o.quality_id]?.sellable && o.qty > 0);
  const sellQty = sellable.reduce((s, o) => s + o.qty, 0);
  if (sellQty <= 0) return { outputs: outputs.map(o => ({ ...o, unit_cost: 0, total_cost: 0 })), lost: total };
  let weights;
  if (method === 'igual') weights = sellable.map(o => o.qty);
  else if (method === 'factor') weights = sellable.map(o => o.qty * (qmap[o.quality_id].cost_factor || 0));
  else if (method === 'valor_venta') weights = sellable.map(o => o.qty * priceOf(db, product_id, o.quality_id));
  else throw bad('Método de asignación inválido.');
  let W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0) { weights = sellable.map(o => o.qty); W = sellQty; } // sin precios/factores: unidades iguales
  let assigned = 0;
  const res = new Map();
  sellable.forEach((o, i) => {
    const t = i === sellable.length - 1 ? r6(total - assigned) : r6(total * weights[i] / W);
    assigned = r6(assigned + t);
    res.set(o, { unit_cost: r6(t / o.qty), total_cost: t });
  });
  return { outputs: outputs.map(o => ({ ...o, ...(res.get(o) || { unit_cost: 0, total_cost: 0 }) })), lost: 0 };
}

// ---------- Lotes de producción ----------
function createBatch(db, ctx, b) {
  const date = V.date(b.date);
  const product_id = V.id(b.product_id, 'Producto');
  const qty = V.num(b.qty_produced, 'Cantidad producida', { gt: 0, int: true });
  const method = V.oneOf(b.allocation_method || db.setting('allocation_method', 'igual'), 'Método de asignación', Object.keys(ALLOCATION_METHODS));
  const recipe_id = V.optId(b.recipe_id);
  const consumptions = V.arr(b.consumptions, 'Insumos utilizados');
  const outputs = V.arr(b.outputs, 'Clasificación de calidad').map((o, i) => ({ quality_id: V.id(o.quality_id, `Calidad ${i + 1}`), qty: V.num(o.qty || 0, `Calidad ${i + 1}: cantidad`, { min: 0, int: true }) }));
  const sumOut = outputs.reduce((s, o) => s + o.qty, 0);
  if (sumOut !== qty) throw bad(`La clasificación (${sumOut}) debe sumar la cantidad producida (${qty}).`);
  const labor = V.num(b.labor_cost || 0, 'Mano de obra', { min: 0 });
  const overhead = V.num(b.overhead_cost || 0, 'Costos indirectos', { min: 0 });
  const minutes = V.num(b.minutes || 0, 'Tiempo', { min: 0 });

  return db.tx(() => {
    const prod = db.get('SELECT * FROM products WHERE id=?', product_id);
    if (!prod) throw bad('Producto no encontrado.');
    const n = db.get('SELECT COUNT(*) n FROM batches WHERE date=?', date).n + 1;
    const code = `L-${date.replace(/-/g, '')}-${String(n).padStart(2, '0')}`;
    const theo = recipe_id ? recipeCost(db, recipe_id, qty) : null;
    const bid = db.insert('batches', {
      code, date, product_id, recipe_id, qty_produced: qty, minutes, labor_cost: labor, overhead_cost: overhead,
      theoretical_cost: theo ? theo.total : null, allocation_method: method,
      expiry_date: b.expiry_date || addDays(date, prod.shelf_life_days || 15), campaign_id: V.optId(b.campaign_id),
      notes: b.notes || null, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id,
    });
    const stdMap = theo ? Object.fromEntries(theo.lines.map(l => [l.item_id, l.qty_scaled])) : {};
    const credits = {};
    let materials = 0;
    const seen = new Set();
    consumptions.forEach((c, i) => {
      const item_id = V.id(c.item_id, `Insumo ${i + 1}`);
      const q = V.num(c.qty, `Insumo ${i + 1}: cantidad`, { min: 0 });
      if (q === 0) return;
      if (seen.has(item_id)) throw bad('Hay un insumo repetido en la lista; combine las cantidades.');
      seen.add(item_id);
      const r = INV.consume(db, { ...ctx, allowNegative: !!b.allow_negative }, { item_id, qty: q, date, type: 'consumo_produccion', ref_type: 'lote', ref_id: bid, note: code });
      db.insert('batch_consumptions', { batch_id: bid, item_id, qty: q, std_qty: stdMap[item_id] ?? null, cost: r.cost, movement_id: r.movement_id });
      materials += r.cost;
      const acc = L.ITEM_ACCOUNT[r.item.type]; credits[acc] = (credits[acc] || 0) + r.cost;
    });
    materials = r6(materials);
    const total = r6(materials + labor + overhead);
    const alloc = allocate(db, { total, product_id, outputs, method });
    const expiry = b.expiry_date || addDays(date, prod.shelf_life_days || 15);
    let fgValue = 0;
    for (const o of alloc.outputs) {
      db.insert('batch_outputs', { batch_id: bid, quality_id: o.quality_id, qty: o.qty, unit_cost: o.unit_cost, total_cost: o.total_cost });
      if (o.qty > 0 && isSellable(db, o.quality_id)) {
        const lid = db.insert('fg_lots', { batch_id: bid, product_id, quality_id: o.quality_id, date, expiry_date: expiry, qty_initial: o.qty, qty_available: o.qty, unit_cost: o.unit_cost });
        db.insert('fg_movements', { lot_id: lid, date, type: 'produccion', qty: o.qty, unit_cost: o.unit_cost, ref_type: 'lote', ref_id: bid, created_at: nowIso(), user_id: ctx.user?.id });
        fgValue += o.total_cost;
      }
    }
    db.update('batches', bid, { materials_cost: materials, total_cost: total });
    L.post(db, ctx, {
      date, description: `Producción ${code}: ${qty} × ${prod.name}`, ref_type: 'lote', ref_id: bid,
      lines: [
        { account: '1304', debit: fgValue }, { account: '5103', debit: alloc.lost, memo: 'Lote sin unidades comercializables' },
        ...Object.entries(credits).map(([account, v]) => ({ account, credit: v })),
        { account: '6190', credit: labor + overhead, memo: 'MO y CIF imputados' },
      ],
    });
    audit(db, ctx, 'crear', 'lote', bid, b);
    return bid;
  });
}
function isSellable(db, qid) { const q = db.get('SELECT sellable FROM quality_categories WHERE id=?', qid); return !!q?.sellable; }

function annulBatch(db, ctx, id, reason) {
  return db.tx(() => {
    const bt = db.get('SELECT * FROM batches WHERE id=?', id);
    if (!bt || bt.status !== 'activo') throw bad('Lote no encontrado o ya anulado.');
    if (!reason) throw bad('Indique el motivo de la anulación.');
    const lots = db.all('SELECT * FROM fg_lots WHERE batch_id=?', id);
    for (const l of lots) if (Math.abs(l.qty_available - l.qty_initial) > EPS) throw bad('No se puede anular: hay unidades de este lote ya vendidas, armadas o ajustadas.');
    for (const l of lots) {
      db.run('UPDATE fg_lots SET qty_available=0 WHERE id=?', l.id);
      db.insert('fg_movements', { lot_id: l.id, date: bt.date, type: 'anulacion', qty: -l.qty_initial, unit_cost: l.unit_cost, ref_type: 'lote', ref_id: id, note: reason, created_at: nowIso(), user_id: ctx.user?.id });
    }
    INV.reverseMovements(db, ctx, 'lote', id, 'Anulación de lote ' + bt.code);
    L.reverseRef(db, ctx, 'lote', id, reason);
    db.update('batches', id, { status: 'anulado', annul_reason: reason });
    audit(db, ctx, 'anular', 'lote', id, { reason });
  });
}

function batchDetail(db, id) {
  const bt = db.get('SELECT b.*, p.name product FROM batches b JOIN products p ON p.id=b.product_id WHERE b.id=?', id);
  if (!bt) throw bad('Lote no encontrado.');
  bt.consumptions = db.all('SELECT c.*, i.name, i.base_unit FROM batch_consumptions c JOIN items i ON i.id=c.item_id WHERE batch_id=?', id);
  bt.outputs = db.all('SELECT o.*, q.name quality, q.code, q.sellable FROM batch_outputs o JOIN quality_categories q ON q.id=o.quality_id WHERE batch_id=? ORDER BY q.sort', id);
  bt.lots = db.all('SELECT l.*, q.name quality FROM fg_lots l JOIN quality_categories q ON q.id=l.quality_id WHERE batch_id=?', id);
  Object.assign(bt, batchMetrics(bt));
  return bt;
}
function batchMetrics(bt) {
  const outs = bt.outputs || [];
  const nonSell = outs.filter(o => !o.sellable).reduce((s, o) => s + o.qty, 0);
  const sell = bt.qty_produced - nonSell;
  const prime = outs.filter(o => o.sellable && o.code === 'A').reduce((s, o) => s + o.qty, 0);
  const second = sell - prime;
  const unitAll = bt.qty_produced ? bt.total_cost / bt.qty_produced : 0;
  return {
    sellable_qty: sell, approved_qty: prime, defect_qty: second, lost_qty: nonSell,
    waste_pct: bt.qty_produced ? nonSell / bt.qty_produced : 0,
    defect_pct: bt.qty_produced ? second / bt.qty_produced : 0,
    yield_pct: bt.qty_produced ? sell / bt.qty_produced : 0,
    unit_cost_produced: r6(unitAll), unit_cost_sellable: sell ? r6(bt.total_cost / sell) : 0,
    waste_value: r6(nonSell * unitAll),
    variance: bt.theoretical_cost != null ? r6(bt.total_cost - bt.theoretical_cost) : null,
    variance_pct: bt.theoretical_cost ? (bt.total_cost - bt.theoretical_cost) / bt.theoretical_cost : null,
  };
}
function listBatches(db, { from, to } = {}) {
  const w = []; const p = [];
  if (from) { w.push('b.date>=?'); p.push(from); } if (to) { w.push('b.date<=?'); p.push(to); }
  return db.all(`SELECT b.*, p.name product FROM batches b JOIN products p ON p.id=b.product_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY b.date DESC, b.id DESC`, ...p)
    .map(bt => { bt.outputs = db.all('SELECT o.*, q.name quality, q.code, q.sellable FROM batch_outputs o JOIN quality_categories q ON q.id=o.quality_id WHERE batch_id=? ORDER BY q.sort', bt.id); return Object.assign(bt, batchMetrics(bt)); });
}

// ---------- Stock de producto terminado ----------
function fgStock(db) {
  return db.all(`SELECT l.product_id, p.name product, l.quality_id, q.name quality, q.code, SUM(l.qty_available) qty,
      SUM(l.qty_available*l.unit_cost) value, MIN(CASE WHEN l.qty_available>0 THEN l.expiry_date END) next_expiry
    FROM fg_lots l JOIN products p ON p.id=l.product_id JOIN quality_categories q ON q.id=l.quality_id
    GROUP BY l.product_id, l.quality_id HAVING SUM(l.qty_available) > 0 ORDER BY p.name, q.sort`)
    .map(r => ({ ...r, avg_cost: r.qty ? r.value / r.qty : 0, price: priceOf(db, r.product_id, r.quality_id) }));
}
function fgLots(db, { available = true } = {}) {
  return db.all(`SELECT l.*, p.name product, q.name quality, q.code, b.code batch_code FROM fg_lots l JOIN products p ON p.id=l.product_id
    JOIN quality_categories q ON q.id=l.quality_id JOIN batches b ON b.id=l.batch_id ${available ? 'WHERE l.qty_available > 0' : ''} ORDER BY l.expiry_date, l.id`);
}

/** Toma unidades de lotes de producto terminado en orden FEFO (primero en vencer). */
function takeFg(db, ctx, { product_id, quality_id, qty, date, ref_type, ref_id, lot_id }) {
  let need = qty;
  const where = lot_id ? 'id=?' : 'product_id=? AND quality_id=?';
  const params = lot_id ? [lot_id] : [product_id, quality_id];
  const lots = db.all(`SELECT * FROM fg_lots WHERE ${where} AND qty_available > 0 ORDER BY expiry_date, id`, ...params);
  const taken = [];
  for (const l of lots) {
    if (need <= EPS) break;
    const q = Math.min(need, l.qty_available);
    db.run('UPDATE fg_lots SET qty_available=? WHERE id=?', r6(l.qty_available - q), l.id);
    db.insert('fg_movements', { lot_id: l.id, date, type: ref_type, qty: -q, unit_cost: l.unit_cost, ref_type, ref_id, created_at: nowIso(), user_id: ctx.user?.id });
    taken.push({ lot_id: l.id, batch_id: l.batch_id, product_id: l.product_id, quality_id: l.quality_id, qty: q, unit_cost: l.unit_cost, cost: r6(q * l.unit_cost) });
    need = r6(need - q);
  }
  if (need > EPS) {
    const p = db.get('SELECT name FROM products WHERE id=?', product_id) || {}; const qn = db.get('SELECT name FROM quality_categories WHERE id=?', quality_id) || {};
    throw bad(`Stock insuficiente de ${p.name || 'producto'} (${qn.name || ''}): faltan ${need} unidades.`, { code: 'stock_negativo' });
  }
  return taken;
}
function returnFg(db, ctx, { lot_id, qty, date, ref_type, ref_id, note }) {
  const l = db.get('SELECT * FROM fg_lots WHERE id=?', lot_id);
  db.run('UPDATE fg_lots SET qty_available=? WHERE id=?', r6(l.qty_available + qty), lot_id);
  db.insert('fg_movements', { lot_id, date, type: 'reingreso', qty, unit_cost: l.unit_cost, ref_type, ref_id, note, created_at: nowIso(), user_id: ctx.user?.id });
  return r6(qty * l.unit_cost);
}

/** Ajuste de producto terminado: baja por merma o reclasificación a otra calidad (conserva costo histórico). */
function adjustFg(db, ctx, b) {
  const date = V.date(b.date); const lot_id = V.id(b.lot_id, 'Lote'); const qty = V.num(b.qty, 'Cantidad', { gt: 0, int: true });
  const action = V.oneOf(b.action, 'Acción', ['merma', 'reclasificar']);
  const reason = V.str(b.reason, 'Motivo');
  return db.tx(() => {
    const l = db.get('SELECT * FROM fg_lots WHERE id=?', lot_id);
    if (!l) throw bad('Lote no encontrado.');
    const [t] = takeFg(db, ctx, { lot_id, qty, date, ref_type: 'ajuste_pt', ref_id: lot_id });
    const cost = t.cost;
    if (action === 'merma') {
      L.post(db, ctx, { date, description: `Merma de producto terminado (lote ${lot_id}): ${reason}`, ref_type: 'ajuste_pt', ref_id: lot_id, lines: [{ account: '5103', debit: cost }, { account: '1304', credit: cost }] });
    } else {
      const qid = V.id(b.to_quality_id, 'Nueva calidad');
      const q = db.get('SELECT * FROM quality_categories WHERE id=?', qid);
      if (!q) throw bad('Calidad no encontrada.');
      if (!q.sellable) {
        L.post(db, ctx, { date, description: `Baja a no comercializable (lote ${lot_id}): ${reason}`, ref_type: 'ajuste_pt', ref_id: lot_id, lines: [{ account: '5103', debit: cost }, { account: '1304', credit: cost }] });
      } else {
        const nid = db.insert('fg_lots', { batch_id: l.batch_id, product_id: l.product_id, quality_id: qid, date, expiry_date: l.expiry_date, qty_initial: qty, qty_available: qty, unit_cost: l.unit_cost, origin_lot_id: l.id });
        db.insert('fg_movements', { lot_id: nid, date, type: 'reclasificacion', qty, unit_cost: l.unit_cost, ref_type: 'ajuste_pt', ref_id: lot_id, note: reason, created_at: nowIso(), user_id: ctx.user?.id });
      }
    }
    audit(db, ctx, 'ajuste', 'producto_terminado', lot_id, b);
  });
}

/** Saldo inicial de producto terminado (productos ya elaborados antes de usar el sistema). */
function openingFg(db, ctx, b) {
  const date = V.date(b.date); const product_id = V.id(b.product_id, 'Producto');
  const quality_id = V.id(b.quality_id, 'Calidad'); const qty = V.num(b.qty, 'Cantidad', { gt: 0, int: true });
  const unit_cost = V.num(b.unit_cost, 'Costo unitario', { min: 0 });
  return db.tx(() => {
    if (!isSellable(db, quality_id)) throw bad('Solo se registran como inventario calidades comercializables.');
    const prod = db.get('SELECT * FROM products WHERE id=?', product_id);
    const bid = db.insert('batches', { code: `INI-${date.replace(/-/g, '')}-${product_id}`, date, product_id, qty_produced: qty, materials_cost: r6(qty * unit_cost), total_cost: r6(qty * unit_cost), allocation_method: 'igual', kind: 'inicial', expiry_date: b.expiry_date || addDays(date, prod.shelf_life_days || 15), notes: b.notes || 'Saldo inicial', created_at: nowIso(), user_id: ctx.user?.id });
    db.insert('batch_outputs', { batch_id: bid, quality_id, qty, unit_cost, total_cost: r6(qty * unit_cost) });
    const lid = db.insert('fg_lots', { batch_id: bid, product_id, quality_id, date, expiry_date: b.expiry_date || addDays(date, prod.shelf_life_days || 15), qty_initial: qty, qty_available: qty, unit_cost });
    db.insert('fg_movements', { lot_id: lid, date, type: 'inicial', qty, unit_cost, ref_type: 'apertura_pt', ref_id: bid, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, { date, description: `Saldo inicial de producto terminado: ${prod.name}`, ref_type: 'apertura_pt', ref_id: bid, lines: [{ account: '1304', debit: r6(qty * unit_cost) }, { account: '3103', credit: r6(qty * unit_cost) }] });
    audit(db, ctx, 'crear', 'saldo_inicial_pt', bid, b);
    return bid;
  });
}

function saveProduct(db, ctx, b, id) {
  const data = { name: V.str(b.name, 'Nombre'), family: b.family || null, shelf_life_days: V.num(b.shelf_life_days ?? 15, 'Vida útil (días)', { min: 0, int: true }), aliases: b.aliases || null, notes: b.notes || null, active: b.active === undefined ? 1 : (b.active ? 1 : 0) };
  return db.tx(() => {
    const pid = id ? (db.update('products', id, data), id) : db.insert('products', { ...data, is_demo: b.is_demo ? 1 : 0 });
    if (b.prices) for (const [qid, price] of Object.entries(b.prices)) {
      if (price === '' || price === null || price === undefined) continue;
      setProductPrice(db, ctx, pid, Number(qid), V.num(price, 'Precio', { min: 0 }), b.price_date);
    }
    audit(db, ctx, id ? 'editar' : 'crear', 'producto', pid, b);
    return pid;
  });
}
/** Cambiar precios no altera costos históricos: queda registrado en el historial de precios. */
function setProductPrice(db, ctx, productId, qualityId, price, date) {
  const old = db.get('SELECT price FROM product_prices WHERE product_id=? AND quality_id=?', productId, qualityId);
  if (old && Math.abs(old.price - price) < 1e-9) return;
  db.run('INSERT INTO product_prices(product_id,quality_id,price) VALUES(?,?,?) ON CONFLICT(product_id,quality_id) DO UPDATE SET price=excluded.price', productId, qualityId, price);
  db.insert('price_history', { entity: 'producto', entity_id: productId, quality_id: qualityId, price, date: date || new Date().toISOString().slice(0, 10), user_id: ctx.user?.id });
}

module.exports = { ALLOCATION_METHODS, qualities, priceOf, recipeCost, saveRecipe, allocate, createBatch, annulBatch, batchDetail, listBatches, batchMetrics, fgStock, fgLots, takeFg, returnFg, adjustFg, openingFg, saveProduct, setProductPrice };
