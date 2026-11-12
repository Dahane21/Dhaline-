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
    for (const c of p.components) {
      const need = c.qty * qty;
      if (c.kind === 'producto') {
        let parts;
        if (c.product_id) parts = [{ product_id: c.product_id, qty: need }];
        else if (fixedFill.length) {
          const s = fixedFill.reduce((t, f) => t + Number(f.qty), 0);
          if (Math.abs(s - c.qty) > EPS) throw bad(`El contenido surtido de "${p.name}" debe sumar ${c.qty} unidades por caja (indicó ${s}).`);
          parts = fixedFill.map(f => ({ product_id: Number(f.product_id), qty: Number(f.qty) * qty }));
        } else parts = [{ product_id: null, qty: need }];
        for (const part of parts) {
          let taken;
          if (part.product_id) taken = P.takeFg(db, ctx, { product_id: part.product_id, quality_id: p.quality_id, qty: part.qty, date, ref_type: 'armado', ref_id: aid });
          else taken = takeAnyFg(db, ctx, { quality_id: p.quality_id, qty: part.qty, date, ref_type: 'armado', ref_id: aid });
          for (const t of taken) {
            db.insert('assembly_consumptions', { assembly_id: aid, source: 'fg', fg_lot_id: t.lot_id, qty: t.qty, cost: t.cost });
            fgCost += t.cost;
            const lot = db.get('SELECT expiry_date FROM fg_lots WHERE id=?', t.lot_id);
            if (lot.expiry_date && (!minExpiry || lot.expiry_date < minExpiry)) minExpiry = lot.expiry_date;
          }
        }
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

module.exports = { getPresentation, savePresentation, presentationCost, assemble, annulAssembly, packStock, listPresentations, availableUnits };
