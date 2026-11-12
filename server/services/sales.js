'use strict';
// Ventas y pedidos: el inventario, el ingreso y el costo de ventas se reconocen al quedar "Listo" o "Entregado".
const { bad, r2, r6, EPS, V } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const P = require('./production');
const PR = require('./presentations');
const { audit } = require('./audit');

const STATUSES = ['pendiente', 'preparacion', 'listo', 'entregado', 'cancelado'];
const FULFILL = ['listo', 'entregado'];

function parseLines(db, lines) {
  return V.arr(lines, 'Productos').map((l, i) => {
    const n = `Línea ${i + 1}`;
    const kind = V.oneOf(l.kind, `${n}: tipo`, ['producto', 'presentacion']);
    const qty = V.num(l.qty, `${n}: cantidad`, { gt: 0, int: true });
    const unit_price = V.num(l.unit_price, `${n}: precio unitario`, { min: 0 });
    const discount = V.num(l.discount || 0, `${n}: descuento`, { min: 0 });
    let row;
    if (kind === 'producto') {
      const product_id = V.id(l.product_id, `${n}: producto`), quality_id = V.id(l.quality_id, `${n}: calidad`);
      const q = db.get('SELECT * FROM quality_categories WHERE id=?', quality_id);
      if (!q?.sellable) throw bad(`${n}: la calidad "${q?.name}" no es comercializable.`);
      row = { kind, product_id, quality_id, presentation_id: null, list_price: P.priceOf(db, product_id, quality_id) };
    } else {
      const presentation_id = V.id(l.presentation_id, `${n}: presentación`);
      const pr = PR.getPresentation(db, presentation_id);
      row = { kind, product_id: null, quality_id: pr.quality_id, presentation_id, list_price: pr.price, fill: l.fill && l.fill.length ? JSON.stringify(l.fill) : null };
    }
    const total = r2(qty * unit_price - discount);
    if (total < 0) throw bad(`${n}: el descuento supera el importe.`);
    return { ...row, qty, unit_price, discount, total };
  });
}

function computeTotals(lines, discount, delivery_charge) {
  const subtotal = r2(lines.reduce((s, l) => s + l.total, 0));
  const total = r2(subtotal - discount + delivery_charge);
  if (total < 0) throw bad('El descuento del pedido supera el subtotal.');
  return { subtotal, total };
}

function header(db, b) {
  const discount = V.num(b.discount || 0, 'Descuento', { min: 0 });
  const delivery_charge = V.num(b.delivery_charge || 0, 'Delivery cobrado', { min: 0 });
  const delivery_cost = V.num(b.delivery_cost || 0, 'Costo de delivery', { min: 0 });
  return {
    date: V.date(b.date), customer_id: V.optId(b.customer_id), channel: b.channel || null, campaign_id: V.optId(b.campaign_id),
    discount, delivery_charge, delivery_cost, delivery_account: delivery_cost > 0 ? L.checkMoney(b.delivery_account || '1101') : null,
    notes: b.notes || null,
  };
}

function createSale(db, ctx, b) {
  const h = header(db, b);
  const status = V.oneOf(b.status || 'pendiente', 'Estado', STATUSES.filter(s => s !== 'cancelado'));
  return db.tx(() => {
    const lines = parseLines(db, b.lines);
    const t = computeTotals(lines, h.discount, h.delivery_charge);
    const code = `V-${String(db.get('SELECT COUNT(*) n FROM sales').n + 1).padStart(4, '0')}`;
    const sid = db.insert('sales', { code, ...h, status: 'pendiente', ...t, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id });
    for (const l of lines) db.insert('sale_lines', { sale_id: sid, ...l });
    audit(db, ctx, 'crear', 'venta', sid, b);
    if (status !== 'pendiente') setStatus(db, ctx, sid, status, { date: h.date, allow_negative: b.allow_negative });
    if (b.payment && Number(b.payment.amount) > 0) addPayment(db, ctx, sid, { date: h.date, ...b.payment });
    return sid;
  });
}

function updateSale(db, ctx, id, b) {
  return db.tx(() => {
    const s = getSale(db, id);
    if (s.fulfilled || s.status === 'cancelado') throw bad('Solo se puede editar un pedido pendiente o en preparación. Para corregir uno despachado use devolución o cancelación.');
    const h = header(db, b);
    const lines = parseLines(db, b.lines);
    const t = computeTotals(lines, h.discount, h.delivery_charge);
    const paid = paidAmount(db, id);
    db.update('sales', id, { ...h, ...t });
    db.run('DELETE FROM sale_lines WHERE sale_id=?', id);
    for (const l of lines) db.insert('sale_lines', { sale_id: id, ...l });
    audit(db, ctx, 'editar', 'venta', id, { before: s, after: b, paid });
    return id;
  });
}

/** Despacho: descuenta productos terminados / presentaciones (y sus componentes), reconoce ingreso y costo. */
function fulfill(db, ctx, sale, date, allowNegative) {
  const lines = db.all('SELECT * FROM sale_lines WHERE sale_id=?', sale.id);
  const fgCredit = { '1304': 0, '1305': 0 };
  let costTotal = 0;
  for (const l of lines) {
    let lineCost = 0;
    if (l.kind === 'producto') {
      const taken = P.takeFg(db, ctx, { product_id: l.product_id, quality_id: l.quality_id, qty: l.qty, date, ref_type: 'venta', ref_id: sale.id });
      for (const t of taken) {
        db.insert('sale_allocations', { line_id: l.id, source: 'fg', lot_id: t.lot_id, qty: t.qty, unit_cost: t.unit_cost });
        db.insert('sale_cost_details', { line_id: l.id, product_id: t.product_id, quality_id: t.quality_id, batch_id: t.batch_id, fg_lot_id: t.lot_id, qty: t.qty, cost: t.cost });
        lineCost += t.cost;
      }
      fgCredit['1304'] += lineCost;
    } else {
      // Primero usa cajas ya armadas; si faltan, arma en el momento (descontando chocotejas y empaques).
      let need = l.qty;
      const packs = db.all('SELECT * FROM pack_lots WHERE presentation_id=? AND qty_available>0 ORDER BY expiry_date, id', l.presentation_id);
      const usedLots = [];
      for (const pl of packs) {
        if (need <= 0) break;
        const q = Math.min(need, pl.qty_available);
        db.run('UPDATE pack_lots SET qty_available=? WHERE id=?', r6(pl.qty_available - q), pl.id);
        usedLots.push({ lot: pl, qty: q }); need -= q;
      }
      if (need > 0) {
        const a = PR.assemble(db, { ...ctx }, { presentation_id: l.presentation_id, qty: need, date, fill: l.fill ? JSON.parse(l.fill) : null, sale_id: sale.id, allow_negative: allowNegative, notes: `Armado para ${sale.code}` });
        const pl = db.get('SELECT * FROM pack_lots WHERE id=?', a.pack_lot_id);
        db.run('UPDATE pack_lots SET qty_available=? WHERE id=?', r6(pl.qty_available - need), pl.id);
        usedLots.push({ lot: pl, qty: need });
      }
      for (const u of usedLots) {
        const c = r6(u.qty * u.lot.unit_cost);
        db.insert('sale_allocations', { line_id: l.id, source: 'pack', lot_id: u.lot.id, qty: u.qty, unit_cost: u.lot.unit_cost });
        lineCost += c;
        // Detalle de trazabilidad: componentes del armado prorrateados por las unidades vendidas
        const a = db.get('SELECT * FROM assemblies WHERE id=?', u.lot.assembly_id);
        const share = u.qty / a.qty;
        for (const ac of db.all('SELECT * FROM assembly_consumptions WHERE assembly_id=?', a.id)) {
          if (ac.source === 'fg') {
            const lot = db.get('SELECT * FROM fg_lots WHERE id=?', ac.fg_lot_id);
            db.insert('sale_cost_details', { line_id: l.id, product_id: lot.product_id, quality_id: lot.quality_id, batch_id: lot.batch_id, fg_lot_id: lot.id, qty: r6(ac.qty * share), cost: r6(ac.cost * share) });
          } else db.insert('sale_cost_details', { line_id: l.id, item_id: ac.item_id, qty: r6(ac.qty * share), cost: r6(ac.cost * share) });
        }
      }
      fgCredit['1305'] += lineCost;
    }
    db.update('sale_lines', l.id, { cost_total: r6(lineCost) });
    costTotal += lineCost;
  }
  const gross = r2(lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const discounts = r2(lines.reduce((s, l) => s + l.discount, 0) + sale.discount);
  const cust = sale.customer_id ? db.get('SELECT name FROM customers WHERE id=?', sale.customer_id) : null;
  L.post(db, ctx, {
    date, description: `Venta ${sale.code}${cust ? ' – ' + cust.name : ''}`, ref_type: 'venta', ref_id: sale.id,
    lines: [
      { account: '1201', debit: sale.total }, { account: '4191', debit: discounts },
      { account: '4101', credit: gross }, { account: '4102', credit: sale.delivery_charge },
      { account: '5101', debit: costTotal }, { account: '1304', credit: fgCredit['1304'] }, { account: '1305', credit: fgCredit['1305'] },
    ],
  });
  db.update('sales', sale.id, { fulfilled: 1, fulfilled_at: date, cost_total: r6(costTotal) });
}

function setStatus(db, ctx, id, status, { date, allow_negative, reason } = {}) {
  V.oneOf(status, 'Estado', STATUSES);
  return db.tx(() => {
    const s = getSale(db, id);
    if (s.status === 'cancelado') throw bad('El pedido está cancelado.');
    if (status === s.status) return;
    const d = date || s.date;
    if (status === 'cancelado') return cancelSale(db, ctx, s, reason);
    if (s.status === 'entregado') throw bad('El pedido ya fue entregado; para corregirlo registre una devolución.');
    if (FULFILL.includes(status) && !s.fulfilled) fulfill(db, { ...ctx, allowNegative: !!allow_negative }, s, s.date, allow_negative);
    if (!FULFILL.includes(status) && s.fulfilled) throw bad('El pedido ya fue despachado (inventario descontado). Para revertir, cancélelo.');
    const upd = { status };
    if (status === 'entregado') {
      upd.delivered_at = d;
      if (s.delivery_cost > 0 && !s.delivery_expense_id) {
        const E = require('./finance');
        upd.delivery_expense_id = E.createExpense(db, ctx, { date: d, category: 'delivery', description: `Delivery pedido ${s.code}`, amount: s.delivery_cost, pay_status: 'pagado', account_code: s.delivery_account || '1101', sale_id: s.id, campaign_id: s.campaign_id, is_demo: s.is_demo });
      }
    }
    db.update('sales', id, upd);
    audit(db, ctx, 'estado', 'venta', id, { from: s.status, to: status });
  });
}

function cancelSale(db, ctx, s, reason) {
  if (s.status === 'entregado') throw bad('Un pedido entregado no se cancela: registre una devolución.');
  if (!reason) throw bad('Indique el motivo de la cancelación.');
  if (s.fulfilled) {
    for (const l of db.all('SELECT * FROM sale_lines WHERE sale_id=?', s.id)) {
      for (const a of db.all('SELECT * FROM sale_allocations WHERE line_id=?', l.id)) {
        if (a.source === 'fg') P.returnFg(db, ctx, { lot_id: a.lot_id, qty: a.qty, date: s.date, ref_type: 'cancelacion', ref_id: s.id, note: reason });
        else db.run('UPDATE pack_lots SET qty_available=qty_available+? WHERE id=?', a.qty, a.lot_id); // las cajas armadas vuelven a stock armado
      }
    }
    L.reverseRef(db, ctx, 'venta', s.id, reason);
  }
  db.update('sales', s.id, { status: 'cancelado', cancel_reason: reason, fulfilled: 0 });
  audit(db, ctx, 'cancelar', 'venta', s.id, { reason, paid: paidAmount(db, s.id) });
}

function paidAmount(db, saleId) { return r2(db.get("SELECT COALESCE(SUM(amount),0) s FROM sale_payments WHERE sale_id=? AND status='activo'", saleId).s); }

/** Cobro (o reembolso si amount < 0). La comisión del medio de pago es gasto del periodo. */
function addPayment(db, ctx, saleId, b) {
  const date = V.date(b.date); const amount = V.num(b.amount, 'Monto');
  if (amount === 0) throw bad('El monto no puede ser cero.');
  const acc = L.checkMoney(b.account_code); const commission = V.num(b.commission || 0, 'Comisión', { min: 0 });
  return db.tx(() => {
    const s = getSale(db, saleId);
    const pid = db.insert('sale_payments', { sale_id: saleId, date, amount, account_code: acc, commission, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, {
      date, description: `${amount > 0 ? 'Cobro' : 'Reembolso'} pedido ${s.code}`, ref_type: 'cobro', ref_id: pid,
      lines: [{ account: acc, debit: amount - commission }, { account: '6105', debit: commission }, { account: '1201', credit: amount }],
    });
    audit(db, ctx, 'crear', 'cobro', pid, b);
    return pid;
  });
}
function annulPayment(db, ctx, pid, reason) {
  return db.tx(() => {
    const p = db.get('SELECT * FROM sale_payments WHERE id=?', pid);
    if (!p || p.status !== 'activo') throw bad('Cobro no encontrado o ya anulado.');
    L.reverseRef(db, ctx, 'cobro', pid, reason);
    db.update('sale_payments', pid, { status: 'anulado', annul_reason: reason || null });
    audit(db, ctx, 'anular', 'cobro', pid, { reason });
  });
}

/** Devolución de un pedido entregado: reduce ingresos (cuenta de devoluciones) y reingresa o da de baja el producto. */
function addReturn(db, ctx, saleId, b) {
  const date = V.date(b.date); const line_id = V.id(b.line_id, 'Línea'); const qty = V.num(b.qty, 'Cantidad', { gt: 0, int: true });
  const amount = V.num(b.amount, 'Monto a devolver', { min: 0 }); const restock = !!b.restock;
  return db.tx(() => {
    const s = getSale(db, saleId);
    if (!s.fulfilled) throw bad('Solo se registran devoluciones de pedidos despachados.');
    const l = db.get('SELECT * FROM sale_lines WHERE id=? AND sale_id=?', line_id, saleId);
    if (!l) throw bad('Línea no encontrada.');
    if (l.returned_qty + qty > l.qty) throw bad('La cantidad devuelta supera la vendida.');
    if (amount > r2(l.total / l.qty * qty) + 0.01) throw bad('El monto devuelto supera lo cobrado por esas unidades.');
    const unitCost = l.cost_total / l.qty; const cost = r6(unitCost * qty);
    const rid = db.insert('sale_returns', { sale_id: saleId, line_id, date, qty, amount, restock: restock ? 1 : 0, cost, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id });
    const lines = [{ account: '4192', debit: amount }, { account: '1201', credit: amount }];
    if (restock) {
      // Reingresa a los mismos lotes de origen (último primero)
      let left = qty;
      for (const a of db.all('SELECT * FROM sale_allocations WHERE line_id=? ORDER BY id DESC', line_id)) {
        if (left <= 0) break; const q = Math.min(left, a.qty);
        if (a.source === 'fg') P.returnFg(db, ctx, { lot_id: a.lot_id, qty: q, date, ref_type: 'devolucion', ref_id: rid });
        else db.run('UPDATE pack_lots SET qty_available=qty_available+? WHERE id=?', q, a.lot_id);
        left -= q;
      }
      lines.push({ account: l.kind === 'producto' ? '1304' : '1305', debit: cost }, { account: '5101', credit: cost });
    } else {
      lines.push({ account: '5103', debit: cost, memo: 'Producto devuelto no recuperable' }, { account: '5101', credit: cost });
    }
    L.post(db, ctx, { date, description: `Devolución pedido ${s.code}`, ref_type: 'devolucion', ref_id: rid, lines });
    db.update('sale_lines', line_id, { returned_qty: l.returned_qty + qty });
    audit(db, ctx, 'crear', 'devolucion', rid, b);
    return rid;
  });
}

function getSale(db, id) {
  const s = db.get('SELECT * FROM sales WHERE id=?', id);
  if (!s) throw bad('Pedido no encontrado.');
  return s;
}
function saleDetail(db, id) {
  const s = db.get('SELECT s.*, c.name customer, c.phone, c.district, cp.name campaign FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN campaigns cp ON cp.id=s.campaign_id WHERE s.id=?', id);
  if (!s) throw bad('Pedido no encontrado.');
  s.lines = db.all(`SELECT l.*, p.name product, q.name quality, pr.name presentation FROM sale_lines l LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN quality_categories q ON q.id=l.quality_id LEFT JOIN presentations pr ON pr.id=l.presentation_id WHERE sale_id=?`, id);
  for (const l of s.lines) l.trace = db.all(`SELECT d.*, b.code batch_code, p.name product, i.name item FROM sale_cost_details d LEFT JOIN batches b ON b.id=d.batch_id
    LEFT JOIN products p ON p.id=d.product_id LEFT JOIN items i ON i.id=d.item_id WHERE line_id=?`, l.id);
  s.payments = db.all('SELECT * FROM sale_payments WHERE sale_id=? ORDER BY date, id', id);
  s.returns = db.all('SELECT * FROM sale_returns WHERE sale_id=? ORDER BY id', id);
  enrich(db, s);
  return s;
}
function enrich(db, s) {
  s.paid = paidAmount(db, s.id);
  const returned = r2(db.get('SELECT COALESCE(SUM(amount),0) a FROM sale_returns WHERE sale_id=?', s.id).a);
  s.returned = returned;
  s.net_total = s.status === 'cancelado' ? 0 : r2(s.total - returned);
  s.balance = r2(s.net_total - s.paid);
  s.pay_status = s.status === 'cancelado' ? (s.paid > 0 ? 'saldo a favor' : 'cancelado') : s.paid <= 0 ? 'pendiente' : s.balance > 0.009 ? 'parcial' : s.balance < -0.009 ? 'saldo a favor' : 'pagado';
  return s;
}
function listSales(db, { from, to, status } = {}) {
  const w = []; const p = [];
  if (from) { w.push('s.date>=?'); p.push(from); } if (to) { w.push('s.date<=?'); p.push(to); } if (status) { w.push('s.status=?'); p.push(status); }
  return db.all(`SELECT s.*, c.name customer, cp.name campaign FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN campaigns cp ON cp.id=s.campaign_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.date DESC, s.id DESC`, ...p).map(s => {
    enrich(db, s);
    s.items = db.all(`SELECT l.qty, COALESCE(pr.name, p.name || ' (' || q.name || ')') name FROM sale_lines l LEFT JOIN products p ON p.id=l.product_id LEFT JOIN quality_categories q ON q.id=l.quality_id LEFT JOIN presentations pr ON pr.id=l.presentation_id WHERE sale_id=?`, s.id)
      .map(x => `${x.qty} × ${x.name}`).join(', ');
    return s;
  });
}

module.exports = { STATUSES, createSale, updateSale, setStatus, addPayment, annulPayment, addReturn, saleDetail, listSales, paidAmount, enrich };
