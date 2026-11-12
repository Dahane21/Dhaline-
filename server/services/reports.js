'use strict';
// Estados financieros, rentabilidad, punto de equilibrio, dashboard y alertas (todo derivado de los movimientos).
const { r2, r6, EPS, today, addDays, monthRange } = require('../lib');
const L = require('./ledger');
const F = require('./finance');

const OPEX = [['6101', 'Gastos operativos'], ['6102', 'Gastos administrativos'], ['6103', 'Marketing'], ['6104', 'Delivery'], ['6105', 'Comisiones de pago'], ['6106', 'Otros egresos'], ['6107', 'Mano de obra pagada']];

function incomeStatement(db, { from, to }) {
  const b = L.balances(db, { from, to }); const g = c => b[c] || 0;
  const salesProducts = -g('4101'), deliveryIncome = -g('4102');
  const gross = salesProducts + deliveryIncome;
  const discounts = g('4191'), returns = g('4192');
  const net = gross - discounts - returns;
  const cogs = g('5101');
  const grossProfit = net - cogs;
  const waste = g('5103');
  const opex = OPEX.map(([code, name]) => ({ code, name, amount: r2(g(code)) }));
  const applied = -g('6190');
  const opexTotal = opex.reduce((s, o) => s + o.amount, 0) - applied;
  const operating = grossProfit - waste - opexTotal;
  const financial = g('6109'); const other = -g('4103');
  const netIncome = operating - financial + other;
  return {
    from, to, sales_products: r2(salesProducts), delivery_income: r2(deliveryIncome), gross_sales: r2(gross), discounts: r2(discounts), returns: r2(returns),
    net_sales: r2(net), cogs: r2(cogs), gross_profit: r2(grossProfit), gross_margin: net ? grossProfit / net : 0, waste: r2(waste),
    opex, applied_conversion: r2(applied), opex_total: r2(opexTotal), operating_profit: r2(operating), financial: r2(financial), other_income: r2(other),
    net_income: r2(netIncome), net_margin: net ? netIncome / net : 0,
  };
}

const CASH_CLASS = {
  cobro: ['operacion', 'Cobros a clientes'], gasto: ['operacion', 'Gastos pagados'], pago_proveedor: ['operacion', 'Pagos a proveedores'],
  capital: ['financiamiento', 'Aportes / retiros de socias'], prestamo: ['financiamiento', 'Préstamos recibidos'], pago_prestamo: ['financiamiento', 'Pagos de préstamos'],
  transferencia: ['interno', 'Transferencias entre cuentas'],
};
function cashFlow(db, { from, to }) {
  const opening = r2(Object.keys(L.MONEY).reduce((s, c) => s + (L.balances(db, { to: addDays(from, -1) })[c] || 0), 0));
  const rows = db.all(`SELECT e.id, e.ref_type, SUM(l.debit - l.credit) amt FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    JOIN accounts a ON a.code=l.account_code WHERE a.money=1 AND e.date BETWEEN ? AND ? GROUP BY e.id`, from, to);
  const groups = {};
  const add = (cls, label, v) => { const k = cls + '|' + label; groups[k] = groups[k] || { class: cls, label, inflow: 0, outflow: 0 }; if (v >= 0) groups[k].inflow += v; else groups[k].outflow += -v; };
  for (const r of rows) {
    if (Math.abs(r.amt) < 1e-9) continue;
    if (r.ref_type === 'compra') {
      // Separa la parte de inversión (activos) de la de inventario/gastos
      const lines = db.all('SELECT account_code, debit FROM journal_lines WHERE entry_id=? AND debit>0', r.id);
      const tot = lines.reduce((s, l) => s + l.debit, 0) || 1;
      const inv = lines.filter(l => l.account_code === '1401').reduce((s, l) => s + l.debit, 0) / tot;
      if (inv > 0) add('inversion', 'Compra de herramientas y activos', r.amt * inv);
      if (inv < 1) add('operacion', 'Compras de insumos y empaques', r.amt * (1 - inv));
    } else {
      const [cls, label] = CASH_CLASS[r.ref_type] || ['operacion', 'Otros movimientos'];
      add(cls, label, r.amt);
    }
  }
  const list = Object.values(groups).map(g => ({ ...g, inflow: r2(g.inflow), outflow: r2(g.outflow), net: r2(g.inflow - g.outflow) }));
  const sum = cls => r2(list.filter(g => g.class === cls).reduce((s, g) => s + g.net, 0));
  const net = sum('operacion') + sum('inversion') + sum('financiamiento') + sum('interno');
  return { from, to, opening, groups: list, operating: sum('operacion'), investing: sum('inversion'), financing: sum('financiamiento'), net: r2(net), closing: r2(opening + net) };
}

function balanceSheet(db, to = today()) {
  const b = L.balances(db, { to });
  const acc = db.all('SELECT * FROM accounts ORDER BY sort');
  const pick = type => acc.filter(a => a.type === type).map(a => ({ code: a.code, name: a.name, amount: r2((type === 'activo' ? 1 : -1) * (b[a.code] || 0)) })).filter(a => Math.abs(a.amount) > 0.004);
  const assets = pick('activo'), liabilities = pick('pasivo'), equity = pick('patrimonio');
  const result = r2(-acc.filter(a => ['ingreso', 'contra_ingreso', 'costo', 'gasto'].includes(a.type)).reduce((s, a) => s + (b[a.code] || 0), 0));
  const tA = r2(assets.reduce((s, a) => s + a.amount, 0)), tL = r2(liabilities.reduce((s, a) => s + a.amount, 0)), tE = r2(equity.reduce((s, a) => s + a.amount, 0) + result);
  return { to, assets, liabilities, equity, result, total_assets: tA, total_liabilities: tL, total_equity: tE, balanced: Math.abs(tA - tL - tE) < 0.02 };
}

function inventoryValue(db) {
  const items = db.all('SELECT type, SUM(stock_value) v FROM items GROUP BY type');
  const val = Object.fromEntries(items.map(i => [i.type, r2(i.v || 0)]));
  const fg = r2(db.get('SELECT COALESCE(SUM(qty_available*unit_cost),0) v FROM fg_lots').v);
  const pk = r2(db.get('SELECT COALESCE(SUM(qty_available*unit_cost),0) v FROM pack_lots').v);
  const rows = [
    { key: 'materia_prima', label: 'Materia prima', value: val.materia_prima || 0 }, { key: 'empaque', label: 'Empaques', value: val.empaque || 0 },
    { key: 'suministro', label: 'Suministros', value: val.suministro || 0 }, { key: 'producto_terminado', label: 'Productos terminados', value: fg },
    { key: 'presentaciones', label: 'Cajas armadas', value: pk },
  ];
  return { rows, total: r2(rows.reduce((s, r) => s + r.value, 0)) };
}

// ---------- Rentabilidad ----------
/** Hechos de venta a nivel de componente: ingreso neto y costo atribuidos a producto, calidad, lote, presentación, canal, campaña. */
function saleFacts(db, { from, to }) {
  const lines = db.all(`SELECT l.*, s.date, s.channel, s.campaign_id, s.customer_id, s.discount hdisc, s.subtotal, s.code,
      cp.name campaign, c.name customer, pr.name presentation, p.name product, q.name quality
    FROM sale_lines l JOIN sales s ON s.id=l.sale_id LEFT JOIN campaigns cp ON cp.id=s.campaign_id LEFT JOIN customers c ON c.id=s.customer_id
    LEFT JOIN presentations pr ON pr.id=l.presentation_id LEFT JOIN products p ON p.id=l.product_id LEFT JOIN quality_categories q ON q.id=l.quality_id
    WHERE s.fulfilled=1 AND s.status!='cancelado' AND s.date BETWEEN ? AND ?`, from, to);
  const facts = [];
  for (const l of lines) {
    const hShare = l.subtotal > 0 ? l.hdisc * (l.total / l.subtotal) : 0;
    const ret = db.get('SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(cost),0) c FROM sale_returns WHERE line_id=?', l.id);
    const keep = l.qty ? (l.qty - l.returned_qty) / l.qty : 0;
    const revenue = l.total - hShare * keep - ret.a;
    const cost = l.cost_total - ret.c;
    const sku = l.kind === 'presentacion' ? l.presentation : `${l.product} suelta (${l.quality})`;
    const base = { date: l.date, sale: l.code, channel: l.channel || 'Sin canal', campaign: l.campaign || 'Sin campaña', customer: l.customer || 'Sin cliente', sku, presentation: l.kind === 'presentacion' ? l.presentation : 'Unidad suelta', line_qty: l.qty - l.returned_qty };
    const det = db.all(`SELECT d.*, p.name product, q.name quality, q.code qcode, b.code batch FROM sale_cost_details d LEFT JOIN products p ON p.id=d.product_id
      LEFT JOIN quality_categories q ON q.id=d.quality_id LEFT JOIN batches b ON b.id=d.batch_id WHERE line_id=?`, l.id);
    const prodRows = det.filter(d => d.fg_lot_id); const pack = det.filter(d => d.item_id).reduce((s, d) => s + d.cost, 0);
    const pUnits = prodRows.reduce((s, d) => s + d.qty, 0);
    const loaded = prodRows.map(d => ({ ...d, lc: d.cost + (pUnits ? pack * d.qty / pUnits : 0) }));
    const lcTot = loaded.reduce((s, d) => s + d.lc, 0);
    for (const d of loaded) {
      const share = lcTot > 0 ? d.lc / lcTot : (pUnits ? d.qty / pUnits : 1 / loaded.length);
      facts.push({ ...base, product: d.product, quality: d.quality, quality_code: d.qcode, batch: d.batch, units: d.qty * keep, revenue: revenue * share, cost: cost * share });
    }
  }
  return facts;
}
function groupFacts(facts, key) {
  const m = new Map();
  for (const f of facts) {
    const k = f[key] ?? '—';
    const g = m.get(k) || { key: k, units: 0, revenue: 0, cost: 0, lines: new Set() };
    g.units += f.units; g.revenue += f.revenue; g.cost += f.cost; g.lines.add(f.sale + '|' + f.sku);
    m.set(k, g);
  }
  return [...m.values()].map(g => ({ key: g.key, units: r2(g.units), revenue: r2(g.revenue), cost: r2(g.cost), margin: r2(g.revenue - g.cost), margin_pct: g.revenue ? (g.revenue - g.cost) / g.revenue : 0 }))
    .sort((a, b) => b.margin - a.margin);
}
function skuSales(db, { from, to }) {
  // Unidades de venta (cajas o sueltas) por SKU
  const rows = db.all(`SELECT l.kind, l.product_id, l.quality_id, l.presentation_id, SUM(l.qty - l.returned_qty) qty, SUM(l.total) total, SUM(l.cost_total) cost,
      COALESCE(pr.name, p.name || ' suelta (' || q.name || ')') name
    FROM sale_lines l JOIN sales s ON s.id=l.sale_id LEFT JOIN products p ON p.id=l.product_id LEFT JOIN quality_categories q ON q.id=l.quality_id LEFT JOIN presentations pr ON pr.id=l.presentation_id
    WHERE s.fulfilled=1 AND s.status!='cancelado' AND s.date BETWEEN ? AND ? GROUP BY l.kind, l.product_id, l.quality_id, l.presentation_id`, from, to);
  return rows.map(r => ({ ...r, sku: r.kind === 'presentacion' ? `B:${r.presentation_id}` : `P:${r.product_id}:${r.quality_id}` }));
}
function profitability(db, { from, to }) {
  const facts = saleFacts(db, { from, to });
  return {
    from, to,
    by_sku: groupFacts(facts, 'sku'), by_product: groupFacts(facts, 'product'), by_presentation: groupFacts(facts, 'presentation'),
    by_quality: groupFacts(facts, 'quality'), by_batch: groupFacts(facts, 'batch'), by_campaign: groupFacts(facts, 'campaign'),
    by_channel: groupFacts(facts, 'channel'), by_customer: groupFacts(facts, 'customer'),
    second_quality: secondQualityAnalysis(db, facts),
  };
}
/** Cuánto se recupera vendiendo productos de segunda y cuánto margen se sacrifica frente al original. */
function secondQualityAnalysis(db, facts) {
  const sec = facts.filter(f => f.quality_code && f.quality_code !== 'A');
  const prem = facts.filter(f => f.quality_code === 'A');
  const pUnits = prem.reduce((s, f) => s + f.units, 0), pRev = prem.reduce((s, f) => s + f.revenue, 0);
  const sUnits = sec.reduce((s, f) => s + f.units, 0), sRev = sec.reduce((s, f) => s + f.revenue, 0), sCost = sec.reduce((s, f) => s + f.cost, 0);
  const premPrice = pUnits ? pRev / pUnits : null;
  const forgone = premPrice !== null ? sUnits * premPrice - sRev : null;
  return { units: r2(sUnits), revenue: r2(sRev), cost: r2(sCost), recovery_pct: sCost ? sRev / sCost : 0, margin: r2(sRev - sCost), premium_avg_price: premPrice !== null ? r2(premPrice) : null, sacrificed_vs_premium: forgone !== null ? r2(forgone) : null };
}

// ---------- Punto de equilibrio multiproducto ----------
function breakEven(db, { month, fixed, mixDays = 90, volume, factors } = {}) {
  month = month || today().slice(0, 7);
  const { from, to } = monthRange(month);
  const fixedCosts = db.all('SELECT * FROM fixed_costs WHERE active=1');
  const F_ = fixed !== undefined && fixed !== null && fixed !== '' ? Number(fixed) : fixedCosts.reduce((s, f) => s + f.monthly_amount, 0);
  const commission = Number(db.setting('commission_pct', '0')) / 100;
  const hist = skuSales(db, { from: addDays(to, -mixDays), to });
  let skus = hist.filter(h => h.qty > 0).map(h => ({ sku: h.sku, name: h.name, hist_qty: h.qty, price: h.total / h.qty, var_cost: h.cost / h.qty + commission * (h.total / h.qty) }));
  let mixSource = `ventas reales de los últimos ${mixDays} días`;
  if (!skus.length) {
    // Sin historial: catálogo actual con mezcla uniforme (editable en escenarios)
    const PR = require('./presentations');
    skus = PR.listPresentations(db).filter(p => p.active && p.price > 0).map(p => ({ sku: `B:${p.id}`, name: p.name, hist_qty: 1, price: p.price, var_cost: p.est_cost + commission * p.price }));
    mixSource = 'catálogo de presentaciones (sin ventas aún: mezcla uniforme)';
  }
  const totQ = skus.reduce((s, k) => s + k.hist_qty, 0);
  skus.forEach(k => { k.mix = totQ ? k.hist_qty / totQ : 0; k.cm = k.price - k.var_cost; k.cm_pct = k.price ? k.cm / k.price : 0; });
  const wcm = skus.reduce((s, k) => s + k.mix * k.cm, 0);
  const wprice = skus.reduce((s, k) => s + k.mix * k.price, 0);
  const beUnits = wcm > 0 ? F_ / wcm : null;
  const cur = Object.fromEntries(skuSales(db, { from, to }).map(c => [c.sku, c]));
  let curUnits = 0, curRev = 0, curCm = 0;
  skus.forEach(k => {
    k.be_units = beUnits !== null ? r2(beUnits * k.mix) : null; k.be_sales = beUnits !== null ? r2(beUnits * k.mix * k.price) : null;
    k.single_be_units = k.cm > 0 ? r2(F_ / k.cm) : null;
    const c = cur[k.sku]; k.current_units = c ? c.qty : 0; curUnits += k.current_units; curRev += c ? c.total : 0; curCm += k.current_units * k.cm;
    k.price = r2(k.price); k.var_cost = r2(k.var_cost); k.cm = r2(k.cm); k.mix = r6(k.mix);
  });
  const beSales = beUnits !== null ? r2(beUnits * wprice) : null;
  // Escenarios sobre volumen mensual esperado
  const baseVol = volume ? Number(volume) : (curUnits || (beUnits ? Math.ceil(beUnits) : 0));
  const fx = Object.assign({ conservador: { vol: 0.7, price: 1, cost: 1.05 }, esperado: { vol: 1, price: 1, cost: 1 }, optimista: { vol: 1.3, price: 1, cost: 0.97 } }, factors || {});
  const scenarios = Object.entries(fx).map(([name, f]) => {
    const units = baseVol * f.vol;
    const rev = skus.reduce((s, k) => s + units * k.mix * k.price * f.price, 0);
    const vc = skus.reduce((s, k) => s + units * k.mix * k.var_cost * f.cost, 0);
    return { name, factors: f, units: r2(units), revenue: r2(rev), variable_costs: r2(vc), contribution: r2(rev - vc), fixed: r2(F_), profit: r2(rev - vc - F_) };
  });
  return {
    month, fixed: r2(F_), fixed_costs: fixedCosts, commission_pct: commission * 100, mix_source: mixSource, skus,
    weighted_cm: r2(wcm), weighted_price: r2(wprice), be_units: beUnits !== null ? r2(beUnits) : null, be_sales: beSales,
    current_units: curUnits, current_sales: r2(curRev), current_contribution: r2(curCm),
    gap_units: beUnits !== null ? r2(beUnits - curUnits) : null, progress_pct: F_ > 0 ? Math.min(curCm / F_, 9.99) : (curUnits > 0 ? 1 : 0),
    base_volume: baseVol, scenarios,
  };
}

// ---------- Alertas ----------
function alerts(db) {
  const out = [];
  const push = (level, type, msg, link) => out.push({ level, type, msg, link });
  for (const it of db.all('SELECT * FROM items WHERE active=1 AND min_stock>0 AND stock_qty<=min_stock'))
    push(it.stock_qty <= 0 ? 'alta' : 'media', it.type === 'empaque' ? 'Empaque por agotarse' : 'Stock bajo', `${it.name}: ${r2(it.stock_qty)} ${it.base_unit} (mínimo ${it.min_stock})`, 'inventario');
  for (const it of db.all('SELECT * FROM items WHERE stock_qty < -1e-6')) push('alta', 'Stock negativo', `${it.name}: ${r2(it.stock_qty)} ${it.base_unit}. Registre la compra o un conteo físico.`, 'inventario');
  const days = Number(db.setting('expiry_alert_days', '3'));
  const limit = addDays(today(), days);
  for (const l of db.all('SELECT l.*, p.name product, q.name quality FROM fg_lots l JOIN products p ON p.id=l.product_id JOIN quality_categories q ON q.id=l.quality_id WHERE qty_available>0 AND expiry_date<=? ORDER BY expiry_date', limit))
    push(l.expiry_date < today() ? 'alta' : 'media', l.expiry_date < today() ? 'Producto vencido' : 'Próximo a vencer', `${l.qty_available} × ${l.product} (${l.quality}) vence ${l.expiry_date}`, 'terminados');
  for (const c of db.all("SELECT c.*, i.name, i.base_unit FROM inventory_counts c JOIN items i ON i.id=c.item_id WHERE ABS(diff_qty)>1e-6 AND date>=? ORDER BY date DESC", addDays(today(), -30)))
    push('media', 'Diferencia de inventario', `${c.name}: sistema ${r2(c.system_qty)} vs físico ${r2(c.counted_qty)} ${c.base_unit} (${c.date}, S/ ${r2(c.diff_value)})`, 'inventario');
  // Margen negativo con precios actuales
  const P = require('./production'); const PR = require('./presentations');
  for (const s of P.fgStock(db)) if (s.price > 0 && s.price < s.avg_cost) push('alta', 'Margen negativo', `${s.product} (${s.quality}) se vende a S/ ${r2(s.price)} y cuesta S/ ${r2(s.avg_cost)}`, 'terminados');
  for (const p of PR.listPresentations(db)) if (p.active && p.price > 0 && p.est_cost > 0 && p.margin < 0) push('alta', 'Margen negativo', `${p.name}: precio S/ ${r2(p.price)} vs costo estimado S/ ${r2(p.est_cost)}`, 'presentaciones');
  for (const l of db.all(`SELECT l.*, s.code, s.date FROM sale_lines l JOIN sales s ON s.id=l.sale_id WHERE s.fulfilled=1 AND s.status!='cancelado' AND s.date>=? AND l.qty>0 AND (l.total / l.qty) < (l.cost_total / l.qty) - 1e-6`, addDays(today(), -30)))
    push('alta', 'Venta bajo el costo', `${l.code} (${l.date}): precio neto S/ ${r2(l.total / l.qty)} < costo S/ ${r2(l.cost_total / l.qty)}`, 'ventas');
  const month = today().slice(0, 7); const { from, to } = monthRange(month);
  for (const bdg of db.all("SELECT * FROM budgets WHERE month=? OR month='*'", month)) {
    const spent = db.get("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE category=? AND status='activo' AND date BETWEEN ? AND ?", bdg.category, from, to).s;
    if (spent > bdg.amount) push('media', 'Gasto sobre presupuesto', `${bdg.category}: S/ ${r2(spent)} de S/ ${r2(bdg.amount)} presupuestado (${month})`, 'finanzas');
  }
  for (const s of F.receivables(db).filter(s => s.balance > 0 && s.status !== 'cancelado')) push(s.fulfilled ? 'media' : 'baja', 'Pedido pendiente de pago', `${s.code} ${s.customer || ''}: saldo S/ ${r2(s.balance)} (${s.status})`, 'ventas');
  const defThr = Number(db.setting('defect_stock_alert', '10'));
  const def = db.get("SELECT COALESCE(SUM(l.qty_available),0) q FROM fg_lots l JOIN quality_categories q ON q.id=l.quality_id WHERE q.code!='A' AND q.sellable=1").q;
  if (def >= defThr) push('media', 'Defectuosos acumulados', `${def} unidades de segunda en stock (umbral ${defThr}). Considere una promoción.`, 'terminados');
  const wThr = Number(db.setting('waste_alert_pct', '15')) / 100;
  for (const b of P.listBatches(db, { from: addDays(today(), -60) })) if (b.status === 'activo' && b.kind === 'produccion' && (b.waste_pct + b.defect_pct) >= wThr)
    push('media', 'Lote con alta merma', `${b.code} ${b.product}: ${Math.round(b.waste_pct * 100)}% no comercializable, ${Math.round(b.defect_pct * 100)}% de segunda`, 'produccion');
  const order = { alta: 0, media: 1, baja: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- Dashboard ----------
function dashboard(db, month) {
  month = month || today().slice(0, 7);
  const { from, to } = monthRange(month);
  const is = incomeStatement(db, { from, to });
  const money = F.moneyBalances(db);
  const rec = F.receivables(db); const pay = F.payables(db);
  const inv = inventoryValue(db);
  const be = breakEven(db, { month });
  // Serie de 12 meses
  const series = [];
  const [y, m] = month.split('-').map(Number);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1)); const mm = d.toISOString().slice(0, 7);
    const r = monthRange(mm); const s = incomeStatement(db, r);
    series.push({ month: mm, net_sales: s.net_sales, gross_profit: s.gross_profit, net_income: s.net_income });
  }
  const prof90 = profitability(db, { from: addDays(to, -90), to });
  const profM = profitability(db, { from, to });
  const top = skuSales(db, { from, to }).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const salesByQuality = profM.by_quality;
  const costs = [{ label: 'Costo de ventas', value: is.cogs }, { label: 'Mermas y ajustes', value: is.waste }, ...is.opex.filter(o => o.amount > 0).map(o => ({ label: o.name, value: o.amount }))];
  return {
    month, kpis: {
      net_sales: is.net_sales, cogs: is.cogs, gross_profit: is.gross_profit, opex: is.opex_total, net_income: is.net_income, net_margin: is.net_margin,
      inventory: inv.total, cash: r2(money.reduce((s, x) => s + x.balance, 0)), receivables: r2(rec.filter(s => s.balance > 0).reduce((s, x) => s + x.balance, 0)),
      payables: pay.total_ledger, be_sales: be.be_sales, be_progress: be.progress_pct,
    },
    income: is, money, inventory: inv, breakeven: { be_units: be.be_units, be_sales: be.be_sales, current_units: be.current_units, current_sales: be.current_sales, progress: be.progress_pct, fixed: be.fixed },
    series, costs, expenses: is.opex.filter(o => o.amount > 0), top_sold: top, top_profitable: prof90.by_sku.slice(0, 5), by_product: prof90.by_product, sales_by_quality: salesByQuality,
    alerts: alerts(db).slice(0, 8), demo: db.setting('demo_loaded') === '1',
  };
}

module.exports = { incomeStatement, cashFlow, balanceSheet, inventoryValue, saleFacts, profitability, breakEven, alerts, dashboard, skuSales };
