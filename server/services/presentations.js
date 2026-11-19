'use strict';
// Presentaciones (caja de 4, 6, navideña...), su estructura de costos y el armado de cajas.
const { bad, r6, EPS, V } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const INV = require('./inventory');
const P = require('./production');
const { audit } = require('./audit');

function getPresentation(db, id) {
  const p = db.get('SELECT pr.*, q.name quality, q.code quality_code FROM presentations pr JOIN quality_categories q ON q.id=pr.quality_id WHERE pr.id=?', id);
  if (!p) throw bad('Presentación no encontrada.');
  p.components = db.all(`SELECT c.*, p.name product_name, i.name item_name, i.base_unit FROM presentation_components c
    LEFT JOIN products p ON p.id=c.product_id LEFT JOIN items i ON i.id=c.item_id WHERE presentation_id=? ORDER BY c.kind DESC, c.id`, id);
  p.units = p.components.filter(c => c.kind === 'producto').reduce((s, c) => s + c.qty, 0);
  return p;
}

function savePresentation(db, ctx, b, id) {
  const data = {
    name: V.str(b.name, 'Nombre'), description: b.description || null, quality_id: V.id(b.quality_id, 'Calidad del contenido'),
    price: V.num(b.price, 'Precio de venta', { min: 0 }), aliases: b.aliases || null, active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
  const comps = V.arr(b.components, 'Componentes').map((c, i) => {
    const kind = V.oneOf(c.kind, `Componente ${i + 1}: tipo`, ['producto', 'empaque']);
    return { kind, product_id: kind === 'producto' ? V.optId(c.product_id) : null, item_id: kind === 'empaque' ? V.id(c.item_id, `Componente ${i + 1}: insumo`) : null, qty: V.num(c.qty, `Componente ${i + 1}: cantidad`, { gt: 0 }) };
  });
  if (!comps.some(c => c.kind === 'producto')) throw bad('La presentación debe contener al menos un producto (o "surtido").');
  return db.tx(() => {
    let pid = id;
    if (id) {
      const old = db.get('SELECT * FROM presentations WHERE id=?', id);
      if (old.price !== data.price) db.insert('price_history', { entity: 'presentacion', entity_id: id, price: data.price, date: new Date().toISOString().slice(0, 10), user_id: ctx.user?.id });
      db.update('presentations', id, data); db.run('DELETE FROM presentation_components WHERE presentation_id=?', id);
    } else {
      pid = db.insert('presentations', { ...data, is_demo: b.is_demo ? 1 : 0 });
      db.insert('price_history', { entity: 'presentacion', entity_id: pid, price: data.price, date: new Date().toISOString().slice(0, 10), user_id: ctx.user?.id });
    }
    for (const c of comps) db.insert('presentation_components', { presentation_id: pid, ...c });
    audit(db, ctx, id ? 'editar' : 'crear', 'presentacion', pid, b);
    return pid;
  });
}

/** Costo estimado actual de una presentación (contenido a costo promedio de stock disponible + empaques). */
function presentationCost(db, id) {
  const p = getPresentation(db, id);
  let content = 0, packaging = 0; const detail = [];
  for (const c of p.components) {
    if (c.kind === 'producto') {
      const where = c.product_id ? 'product_id=? AND quality_id=?' : 'quality_id=?';
      const params = c.product_id ? [c.product_id, p.quality_id] : [p.quality_id];
      const r = db.get(`SELECT SUM(qty_available*unit_cost) v, SUM(qty_available) q FROM fg_lots WHERE ${where} AND qty_available>0`, ...params);
      let uc = r && r.q ? r.v / r.q : null;
      if (uc === null) { // sin stock: último costo de lote conocido
        const last = db.get(`SELECT unit_cost FROM fg_lots WHERE ${where} ORDER BY id DESC LIMIT 1`, ...params);
        uc = last ? last.unit_cost : 0;
      }
      content += uc * c.qty; detail.push({ name: c.product_name || 'Surtido', qty: c.qty, unit_cost: uc, cost: uc * c.qty, kind: 'producto' });
    } else {
      const uc = INV.currentCost(db, c.item_id); packaging += uc * c.qty;
      detail.push({ name: c.item_name, qty: c.qty, unit_cost: uc, cost: uc * c.qty, kind: 'empaque' });
    }
  }
  const total = content + packaging;
  return { presentation: p, content: r6(content), packaging: r6(packaging), total: r6(total), margin: r6(p.price - total), margin_pct: p.price ? (p.price - total) / p.price : 0, detail };
}

function availableUnits(db, product_id, quality_id) {
  const r = db.get(`SELECT SUM(qty_available) q FROM fg_lots WHERE ${product_id ? 'product_id=? AND ' : ''}quality_id=? AND qty_available>0`, ...(product_id ? [product_id, quality_id] : [quality_id]));
  return r?.q || 0;
}

/**
 * Arma `qty` presentaciones: descuenta producto terminado (FEFO) y empaques; crea un lote de presentaciones armadas.
 * fill: para componentes "surtido", [{product_id, qty}] por presentación (opcional; si no, toma lo más próximo a vencer).
 */
function assemble(db, ctx, { presentation_id, qty, date, fill, sale_id, notes, allow_negative, is_demo }) {
  V.date(date); qty = V.num(qty, 'Cantidad a armar', { gt: 0, int: true });
  return db.tx(() => {
    const p = getPresentation(db, presentation_id);
    const code = `A-${String(db.get('SELECT COUNT(*) n FROM assemblies').n + 1).padStart(4, '0')}`;
    const aid = db.insert('assemblies', { code, date, presentation_id: p.id, qty, unit_cost: 0, total_cost: 0, sale_id: sale_id || null, notes: notes || null, is_demo: is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id });
    let fgCost = 0; const itemCredits = {};
    let minExpiry = null;
    const fixedFill = Array.isArray(fill) ? fill.filter(f => Number(f.qty) > 0) : [];
    const unitsPerBox = p.components.filter(c => c.kind === 'producto').reduce((t, c) => t + c.qty, 0);
    // La mezcla elegida al armar REEMPLAZA el contenido configurado de la presentación (debe sumar lo mismo por caja).
    const parts = fixedFill.length ? parseFill(fixedFill, unitsPerBox, p.name).map(f => ({ product_id: f.product_id, qty: f.qty * qty })) : null;
    const takeParts = (list) => {
      for (const part of list) {
        const taken = part.product_id
          ? P.takeFg(db, ctx, { product_id: part.product_id, quality_id: p.quality_id, qty: part.qty, date, ref_type: 'armado', ref_id: aid })
          : takeAnyFg(db, ctx, { quality_id: p.quality_id, qty: part.qty, date, ref_type: 'armado', ref_id: aid });
        for (const t of taken) {
          db.insert('assembly_consumptions', { assembly_id: aid, source: 'fg', fg_lot_id: t.lot_id, qty: t.qty, cost: t.cost });
          fgCost += t.cost;
          const lot = db.get('SELECT expiry_date FROM fg_lots WHERE id=?', t.lot_id);
          if (lot.expiry_date && (!minExpiry || lot.expiry_date < minExpiry)) minExpiry = lot.expiry_date;
        }
      }
    };
    if (parts) takeParts(parts);
    for (const c of p.components) {
      const need = c.qty * qty;
      if (c.kind === 'producto') {
        if (!parts) takeParts([{ product_id: c.product_id || null, qty: need }]);
      } else {
        const r = INV.consume(db, { ...ctx, allowNegative: !!allow_negative }, { item_id: c.item_id, qty: need, date, type: 'consumo_empaque', ref_type: 'armado', ref_id: aid, note: `${code} ${p.name}` });
        db.insert('assembly_consumptions', { assembly_id: aid, source: 'item', item_id: c.item_id, qty: need, cost: r.cost });
        const acc = L.ITEM_ACCOUNT[r.item.type]; itemCredits[acc] = (itemCredits[acc] || 0) + r.cost;
      }
    }
    const total = r6(fgCost + Object.values(itemCredits).reduce((s, v) => s + v, 0));
    const unit = r6(total / qty);
    db.update('assemblies', aid, { unit_cost: unit, total_cost: total });
    const plid = db.insert('pack_lots', { assembly_id: aid, presentation_id: p.id, date, expiry_date: minExpiry, qty_initial: qty, qty_available: qty, unit_cost: unit });
    L.post(db, ctx, {
      date, description: `Armado ${code}: ${qty} × ${p.name}`, ref_type: 'armado', ref_id: aid,
      lines: [{ account: '1305', debit: total }, { account: '1304', credit: fgCost }, ...Object.entries(itemCredits).map(([account, v]) => ({ account, credit: v }))],
    });
    audit(db, ctx, 'crear', 'armado', aid, { presentation_id, qty, fill });
    return { id: aid, pack_lot_id: plid, unit_cost: unit };
  });
}

function parseFill(fill, unitsPerBox, name) {
  const list = fill.map(f => ({ product_id: V.id(f.product_id, 'Sabor'), qty: V.num(f.qty, 'Cantidad por caja', { gt: 0, int: true }) }));
  const sum = list.reduce((t, f) => t + f.qty, 0);
  if (Math.abs(sum - unitsPerBox) > EPS) throw bad(`El contenido de "${name}" debe sumar ${unitsPerBox} chocotejas por caja (indicó ${sum}).`);
  return list;
}

/**
 * Corrige el contenido (sabores) de un armado ya registrado, aunque las cajas ya se hayan vendido.
 * Devuelve las chocotejas tomadas a sus lotes, toma las correctas y ajusta el costo: la diferencia va a
 * cajas armadas (si siguen en stock) o al costo de ventas (si ya se vendieron), y se recalcula la trazabilidad.
 */
function correctAssembly(db, ctx, id, fill) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM assemblies WHERE id=?', id);
    if (!a || a.status !== 'activo') throw bad('Armado no encontrado o anulado.');
    const p = getPresentation(db, a.presentation_id);
    const oldFg = db.all("SELECT * FROM assembly_consumptions WHERE assembly_id=? AND source='fg'", id);
    const unitsPerBox = oldFg.reduce((t, c) => t + c.qty, 0) / a.qty;
    const list = parseFill(Array.isArray(fill) ? fill.filter(f => Number(f.qty) > 0) : [], unitsPerBox, p.name);
    const oldCost = oldFg.reduce((t, c) => t + c.cost, 0);
    for (const c of oldFg) P.returnFg(db, ctx, { lot_id: c.fg_lot_id, qty: c.qty, date: a.date, ref_type: 'correccion_armado', ref_id: id, note: 'Corrección de contenido' });
    db.run("DELETE FROM assembly_consumptions WHERE assembly_id=? AND source='fg'", id);
    let newCost = 0;
    for (const f of list) for (const t of P.takeFg(db, ctx, { product_id: f.product_id, quality_id: p.quality_id, qty: f.qty * a.qty, date: a.date, ref_type: 'correccion_armado', ref_id: id })) {
      db.insert('assembly_consumptions', { assembly_id: id, source: 'fg', fg_lot_id: t.lot_id, qty: t.qty, cost: t.cost });
      newCost += t.cost;
    }
    const diff = r6(newCost - oldCost);
    const total = r6(a.total_cost + diff); const unit = r6(total / a.qty);
    db.update('assemblies', id, { total_cost: total, unit_cost: unit });
    const pl = db.get('SELECT * FROM pack_lots WHERE assembly_id=?', id);
    db.update('pack_lots', pl.id, { unit_cost: unit });
    // Ventas que usaron estas cajas: costo y trazabilidad recalculados
    const allocs = db.all("SELECT a.*, l.sale_id FROM sale_allocations a JOIN sale_lines l ON l.id=a.line_id JOIN sales s ON s.id=l.sale_id WHERE a.source='pack' AND a.lot_id=? AND s.fulfilled=1", pl.id);
    let soldQty = 0;
    const comps = db.all('SELECT * FROM assembly_consumptions WHERE assembly_id=?', id);
    for (const al of allocs) {
      soldQty += al.qty;
      db.update('sale_allocations', al.id, { unit_cost: unit });
      db.run("DELETE FROM sale_cost_details WHERE line_id=? AND (fg_lot_id IN (SELECT fg_lot_id FROM assembly_consumptions WHERE assembly_id=?) OR fg_lot_id IN (" + (oldFg.map(c => c.fg_lot_id).join(',') || '0') + ") OR item_id IN (SELECT item_id FROM assembly_consumptions WHERE assembly_id=? AND source='item'))", al.line_id, id, id);
      const share = al.qty / a.qty;
      for (const c of comps) {
        if (c.source === 'fg') { const lot = db.get('SELECT * FROM fg_lots WHERE id=?', c.fg_lot_id); db.insert('sale_cost_details', { line_id: al.line_id, product_id: lot.product_id, quality_id: lot.quality_id, batch_id: lot.batch_id, fg_lot_id: lot.id, qty: r6(c.qty * share), cost: r6(c.cost * share) }); }
        else db.insert('sale_cost_details', { line_id: al.line_id, item_id: c.item_id, qty: r6(c.qty * share), cost: r6(c.cost * share) });
      }
      const lc = db.get('SELECT COALESCE(SUM(qty*unit_cost),0) c FROM sale_allocations WHERE line_id=?', al.line_id).c;
      db.update('sale_lines', al.line_id, { cost_total: r6(lc) });
      const sc = db.get('SELECT COALESCE(SUM(cost_total),0) c FROM sale_lines WHERE sale_id=?', al.sale_id).c;
      db.update('sales', al.sale_id, { cost_total: r6(sc) });
    }
    const soldDiff = r6(diff * soldQty / a.qty), stockDiff = r6(diff - soldDiff);
    L.post(db, ctx, { date: a.date, description: `Corrección de contenido del armado ${a.code}`, ref_type: 'armado_correccion', ref_id: id,
      lines: [{ account: '1304', credit: diff }, { account: '1305', debit: stockDiff }, { account: '5101', debit: soldDiff }] });
    audit(db, ctx, 'corregir', 'armado', id, { fill: list, diff });
    return { diff };
  });
}

function takeAnyFg(db, ctx, { quality_id, qty, date, ref_type, ref_id }) {
  const lots = db.all('SELECT product_id FROM fg_lots WHERE quality_id=? AND qty_available>0 ORDER BY expiry_date, id', quality_id);
  const total = db.get('SELECT SUM(qty_available) q FROM fg_lots WHERE quality_id=? AND qty_available>0', quality_id)?.q || 0;
  if (total + EPS < qty) { const qn = db.get('SELECT name FROM quality_categories WHERE id=?', quality_id); throw bad(`Stock insuficiente de chocotejas (${qn?.name}) para armar: disponibles ${total}, se requieren ${qty}.`, { code: 'stock_negativo' }); }
  let need = qty; const out = [];
  const seen = new Set();
  for (const l of lots) {
    if (need <= EPS) break; if (seen.has(l.product_id)) continue; seen.add(l.product_id);
    const avail = availableUnits(db, l.product_id, quality_id);
    const q = Math.min(need, avail);
    out.push(...P.takeFg(db, ctx, { product_id: l.product_id, quality_id, qty: q, date, ref_type, ref_id }));
    need -= q;
  }
  return out;
}

function annulAssembly(db, ctx, id, reason) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM assemblies WHERE id=?', id);
    if (!a || a.status !== 'activo') throw bad('Armado no encontrado o ya anulado.');
    const pl = db.get('SELECT * FROM pack_lots WHERE assembly_id=?', id);
    if (Math.abs(pl.qty_available - pl.qty_initial) > EPS) throw bad('No se puede desarmar: hay presentaciones de este armado ya vendidas.');
    db.run('UPDATE pack_lots SET qty_available=0 WHERE id=?', pl.id);
    for (const c of db.all("SELECT * FROM assembly_consumptions WHERE assembly_id=? AND source='fg'", id)) P.returnFg(db, ctx, { lot_id: c.fg_lot_id, qty: c.qty, date: a.date, ref_type: 'desarmado', ref_id: id, note: reason });
    INV.reverseMovements(db, ctx, 'armado', id, 'Desarmado');
    L.reverseRef(db, ctx, 'armado', id, reason);
    db.update('assemblies', id, { status: 'anulado', annul_reason: reason || null });
    audit(db, ctx, 'anular', 'armado', id, { reason });
  });
}

function packStock(db) {
  return db.all(`SELECT pl.presentation_id, pr.name, SUM(pl.qty_available) qty, SUM(pl.qty_available*pl.unit_cost) value, MIN(pl.expiry_date) next_expiry
    FROM pack_lots pl JOIN presentations pr ON pr.id=pl.presentation_id WHERE pl.qty_available>0 GROUP BY pl.presentation_id ORDER BY pr.name`);
}

function listPresentations(db) {
  return db.all('SELECT id FROM presentations ORDER BY active DESC, price').map(r => {
    const c = presentationCost(db, r.id);
    const stock = db.get('SELECT SUM(qty_available) q FROM pack_lots WHERE presentation_id=? AND qty_available>0', r.id)?.q || 0;
    return { ...c.presentation, est_cost: c.total, content_cost: c.content, packaging_cost: c.packaging, margin: c.margin, margin_pct: c.margin_pct, assembled_stock: stock, detail: c.detail };
  });
}

module.exports = { getPresentation, savePresentation, presentationCost, assemble, correctAssembly, annulAssembly, packStock, listPresentations, availableUnits };
