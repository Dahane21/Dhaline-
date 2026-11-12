'use strict';
// Motor de reportes tabulares: el mismo dataset sirve para pantalla (JSON), Excel (.xlsx) e impresión/PDF (HTML).
const ExcelJS = require('exceljs');
const { r2, today } = require('./lib');
const R = require('./services/reports');
const P = require('./services/production');
const PR = require('./services/presentations');
const INV = require('./services/inventory');
const PU = require('./services/purchases');
const S = require('./services/sales');

const pct = x => (x === null || x === undefined ? '' : Math.round(x * 1000) / 10 + '%');

function build(db, name, f) {
  const from = f.from || today().slice(0, 7) + '-01', to = f.to || today();
  const like = (v, s) => !s || String(v || '').toLowerCase().includes(String(s).toLowerCase());
  switch (name) {
    case 'ventas': {
      const rows = S.listSales(db, { from, to, status: f.status }).filter(s => like(s.customer, f.customer) && like(s.campaign, f.campaign) && like(s.items, f.product));
      return t('Reporte de ventas', from, to, ['Código', 'Fecha', 'Cliente', 'Canal', 'Campaña', 'Productos', 'Estado', 'Pago', 'Total', 'Cobrado', 'Saldo', 'Costo'],
        rows.map(s => [s.code, s.date, s.customer || '', s.channel || '', s.campaign || '', s.items, s.status, s.pay_status, s.net_total, s.paid, s.balance, r2(s.cost_total)]), [8, 9, 10, 11]);
    }
    case 'compras': {
      const rows = [];
      for (const p of PU.listPurchases(db, { from, to })) for (const l of p.lines) if (like(l.item_name || l.description, f.product) && like(l.category || l.kind, f.category))
        rows.push([p.code, p.date, p.supplier || '', l.kind, l.item_name || l.description, l.qty, l.unit, l.unit_price, l.total, p.pay_status, p.status]);
      return t('Reporte de compras', from, to, ['Código', 'Fecha', 'Proveedor', 'Tipo', 'Producto', 'Cantidad', 'Unidad', 'P. unitario', 'Importe', 'Pago', 'Estado'], rows, [7, 8]);
    }
    case 'kardex': {
      const items = f.item_id ? [INV.getItem(db, Number(f.item_id))] : db.all('SELECT * FROM items ORDER BY type, name');
      const rows = [];
      for (const it of items) for (const m of db.all('SELECT * FROM inventory_movements WHERE item_id=? AND date BETWEEN ? AND ? ORDER BY id', it.id, from, to))
        rows.push([it.name, m.date, m.type, m.qty > 0 ? m.qty : '', m.qty < 0 ? -m.qty : '', it.base_unit, m.unit_cost, m.total_cost, m.balance_qty, m.balance_value, m.note || '']);
      return t('Kárdex de inventario (promedio ponderado)', from, to, ['Insumo', 'Fecha', 'Movimiento', 'Entrada', 'Salida', 'Unidad', 'Costo unit.', 'Costo total', 'Saldo cant.', 'Saldo valor', 'Detalle'], rows, [6, 7, 9]);
    }
    case 'produccion': {
      const rows = P.listBatches(db, { from, to }).filter(b => like(b.product, f.product) && like(b.code, f.batch)).map(b => {
        const o = code => (b.outputs.find(x => x.code === code) || {});
        return [b.code, b.date, b.product, b.status, b.qty_produced, o('A').qty || 0, o('B').qty || 0, o('C').qty || 0, b.materials_cost, b.labor_cost + b.overhead_cost, b.total_cost, b.unit_cost_sellable, o('A').unit_cost || 0, o('B').unit_cost || 0, b.theoretical_cost ?? '', b.variance ?? '', pct(b.waste_pct), b.allocation_method];
      });
      return t('Costeo de producción por lote', from, to, ['Lote', 'Fecha', 'Producto', 'Estado', 'Producidas', 'Originales', 'Segunda', 'No comerc.', 'Materiales', 'MO+CIF', 'Costo total', 'Costo/u comerc.', 'Costo/u original', 'Costo/u segunda', 'Costo teórico', 'Variación', '% merma', 'Método'], rows, [8, 9, 10, 11, 12, 13, 14, 15]);
    }
    case 'fichas': {
      const rows = [];
      for (const rc of db.all('SELECT r.*, p.name product FROM recipes r JOIN products p ON p.id=r.product_id WHERE r.active=1')) {
        const c = P.recipeCost(db, rc.id);
        for (const l of c.lines) rows.push([rc.name, rc.product, rc.yield_qty, l.name, l.qty, l.base_unit, l.unit_cost, l.cost]);
        rows.push([rc.name, rc.product, rc.yield_qty, 'MO + CIF', '', '', '', r2(c.labor + c.overhead)]);
        rows.push([rc.name, rc.product, rc.yield_qty, 'TOTAL (costo unitario ' + r2(c.unit_cost) + ')', '', '', '', r2(c.total)]);
      }
      return t('Fichas técnicas (costo teórico a precios vigentes)', null, null, ['Receta', 'Producto', 'Rinde', 'Componente', 'Cantidad', 'Unidad', 'Costo unit.', 'Costo'], rows, [6, 7]);
    }
    case 'resultados': {
      const is = R.incomeStatement(db, { from, to });
      const rows = [['Ventas de productos', is.sales_products], ['Delivery cobrado', is.delivery_income], ['Ventas brutas', is.gross_sales], ['(-) Descuentos', -is.discounts], ['(-) Devoluciones', -is.returns], ['Ventas netas', is.net_sales],
        ['(-) Costo de ventas', -is.cogs], ['Utilidad bruta', is.gross_profit], ['Margen bruto', pct(is.gross_margin)], ['(-) Mermas y ajustes de inventario', -is.waste],
        ...is.opex.map(o => ['(-) ' + o.name, -o.amount]), ['(+) MO y CIF imputados aplicados a producción', is.applied_conversion], ['Utilidad operativa', is.operating_profit],
        ['(-) Gastos financieros', -is.financial], ['(+) Otros ingresos', is.other_income], ['Utilidad neta', is.net_income], ['Margen neto', pct(is.net_margin)]];
      return t('Estado de resultados', from, to, ['Concepto', 'S/'], rows, [1]);
    }
    case 'flujo': {
      const cf = R.cashFlow(db, { from, to });
      const rows = [['Saldo inicial', '', '', cf.opening], ...cf.groups.map(g => [`${g.class}: ${g.label}`, g.inflow, g.outflow, g.net]), ['Flujo de operación', '', '', cf.operating], ['Flujo de inversión', '', '', cf.investing], ['Flujo de financiamiento', '', '', cf.financing], ['Saldo final', '', '', cf.closing]];
      return t('Flujo de caja', from, to, ['Concepto', 'Ingresos', 'Egresos', 'Neto'], rows, [1, 2, 3]);
    }
    case 'inventario': {
      const rows = [];
      for (const it of INV.listItems(db)) if (Math.abs(it.stock_qty) > 1e-9 || f.all) rows.push([labelType(it.type), it.name, it.stock_qty, it.base_unit, it.avg_cost, it.stock_value, it.min_stock]);
      for (const s of P.fgStock(db)) rows.push(['Producto terminado', `${s.product} (${s.quality})`, s.qty, 'und', s.avg_cost, s.value, '']);
      for (const s of PR.packStock(db)) rows.push(['Caja armada', s.name, s.qty, 'und', s.qty ? s.value / s.qty : 0, s.value, '']);
      const tot = rows.reduce((s, r) => s + (r[5] || 0), 0); rows.push(['TOTAL', '', '', '', '', r2(tot), '']);
      return t('Balance de inventario valorizado', null, today(), ['Tipo', 'Producto', 'Cantidad', 'Unidad', 'Costo promedio', 'Valor', 'Mínimo'], rows, [4, 5]);
    }
    case 'rentabilidad': {
      const p = R.profitability(db, { from, to });
      const dims = [['by_sku', 'Presentación / SKU'], ['by_product', 'Producto'], ['by_quality', 'Calidad'], ['by_batch', 'Lote'], ['by_campaign', 'Campaña'], ['by_channel', 'Canal'], ['by_customer', 'Cliente']];
      const rows = [];
      for (const [k, label] of dims) for (const g of p[k]) rows.push([label, g.key, g.units, g.revenue, g.cost, g.margin, pct(g.margin_pct)]);
      return t('Reporte de rentabilidad', from, to, ['Dimensión', 'Elemento', 'Unidades', 'Ingreso neto', 'Costo', 'Margen', 'Margen %'], rows, [3, 4, 5]);
    }
    case 'equilibrio': {
      const be = R.breakEven(db, { month: f.month || to.slice(0, 7), fixed: f.fixed });
      const rows = be.skus.map(k => [k.name, k.price, k.var_cost, k.cm, pct(k.cm_pct), pct(k.mix), k.be_units, k.be_sales, k.single_be_units, k.current_units]);
      rows.push(['TOTAL / ponderado', be.weighted_price, '', be.weighted_cm, '', '100%', be.be_units, be.be_sales, '', be.current_units]);
      rows.push([`Costos fijos: S/ ${be.fixed} · Avance: ${pct(be.progress_pct)} · Mezcla: ${be.mix_source}`, '', '', '', '', '', '', '', '', '']);
      for (const s of be.scenarios) rows.push([`Escenario ${s.name}`, '', '', s.contribution, '', '', s.units, s.revenue, '', `Utilidad ${s.profit}`]);
      return t(`Punto de equilibrio multiproducto (${be.month})`, null, null, ['Presentación', 'Precio', 'Costo variable', 'Margen contrib.', 'MC %', 'Mezcla', 'Unid. equilibrio', 'Ventas equilibrio', 'Equilibrio si solo esta', 'Vendidas mes'], rows, [1, 2, 3, 7]);
    }
    case 'defectuosos': {
      const rows = db.all(`SELECT b.code, b.date, p.name product, q.name quality, o.qty, o.unit_cost, o.total_cost, q.sellable FROM batch_outputs o JOIN batches b ON b.id=o.batch_id JOIN products p ON p.id=b.product_id
        JOIN quality_categories q ON q.id=o.quality_id WHERE q.code!='A' AND o.qty>0 AND b.status='activo' AND b.date BETWEEN ? AND ? ORDER BY b.date`, from, to)
        .map(r => [r.code, r.date, r.product, r.quality, r.qty, r.sellable ? r.unit_cost : 'merma', r.sellable ? r.total_cost : '']);
      const p = R.profitability(db, { from, to }).second_quality;
      rows.push(['Ventas de segunda en el periodo', '', '', '', p.units, `Recupera ${pct(p.recovery_pct)} de su costo`, p.revenue]);
      if (p.sacrificed_vs_premium !== null) rows.push(['Margen sacrificado frente al precio original', '', '', '', '', '', p.sacrificed_vs_premium]);
      return t('Reporte de productos defectuosos y mermas', from, to, ['Lote', 'Fecha', 'Producto', 'Calidad', 'Cantidad', 'Costo unit.', 'Costo total'], rows, [6]);
    }
    case 'socias': {
      const rows = db.all(`SELECT m.date, p.name, m.type, m.amount, m.account_code, m.status, m.notes FROM capital_moves m JOIN partners p ON p.id=m.partner_id WHERE m.date BETWEEN ? AND ? ORDER BY m.date`, from, to)
        .map(r => [r.date, r.name, r.type, r.type === 'aporte' ? r.amount : -r.amount, r.account_code, r.status, r.notes || '']);
      for (const s of db.all(`SELECT p.name, SUM(CASE WHEN type='aporte' THEN amount ELSE -amount END) net FROM capital_moves m JOIN partners p ON p.id=m.partner_id WHERE m.status='activo' GROUP BY p.id`)) rows.push(['Saldo neto acumulado', s.name, '', r2(s.net), '', '', '']);
      return t('Aportes y retiros de las socias', from, to, ['Fecha', 'Socia', 'Tipo', 'Monto', 'Cuenta', 'Estado', 'Notas'], rows, [3]);
    }
    default: throw Object.assign(new Error('Reporte no encontrado.'), { status: 404 });
  }
}
function labelType(t) { return { materia_prima: 'Materia prima', empaque: 'Empaque', suministro: 'Suministro' }[t] || t; }
function t(title, from, to, columns, rows, moneyCols = []) { return { title, from, to, columns, rows, moneyCols }; }

async function toXlsx(rep, company) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'Chocolate Business Manager';
  const ws = wb.addWorksheet(rep.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ''));
  ws.addRow([`${company} – ${rep.title}`]).font = { bold: true, size: 14, color: { argb: 'FF6B1E34' } };
  ws.addRow([rep.from || rep.to ? `Periodo: ${rep.from || ''} al ${rep.to || ''}` : `Generado: ${today()}`]);
  ws.addRow([]);
  const h = ws.addRow(rep.columns);
  h.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B1E34' } }; });
  for (const r of rep.rows) ws.addRow(r.map(v => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v)));
  rep.moneyCols.forEach(i => { ws.getColumn(i + 1).numFmt = '#,##0.00'; });
  ws.columns.forEach((c, i) => { c.width = Math.min(45, Math.max(10, ...[rep.columns[i] || '', ...rep.rows.map(r => r[i])].map(v => String(v ?? '').length + 2))); });
  return wb.xlsx.writeBuffer();
}

function toHtml(rep, company) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, i) => typeof v === 'number' ? (rep.moneyCols.includes(i) ? v.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(Math.round(v * 1000) / 1000)) : esc(v);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(rep.title)}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;color:#2b1a1f;margin:24px}h1{color:#6b1e34;font-size:20px;margin:0}p{color:#7a5f66;margin:4px 0 16px}
table{border-collapse:collapse;width:100%;font:12px system-ui,sans-serif}th{background:#6b1e34;color:#fff;text-align:left;padding:6px}td{padding:5px 6px;border-bottom:1px solid #eadbd5}
td.n{text-align:right;font-variant-numeric:tabular-nums}tr:nth-child(even) td{background:#fbf6f2}.no-print{margin-bottom:12px}@media print{.no-print{display:none}body{margin:0}}</style></head>
<body><div class="no-print"><button id="p">Imprimir / Guardar como PDF</button></div><h1>${esc(company)} – ${esc(rep.title)}</h1>
<p>${rep.from || rep.to ? `Periodo: ${esc(rep.from || '')} al ${esc(rep.to || '')}` : ''} · Generado ${esc(new Date().toLocaleString('es-PE'))}</p>
<table><thead><tr>${rep.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
${rep.rows.map(r => `<tr>${r.map((v, i) => `<td class="${typeof v === 'number' ? 'n' : ''}">${fmt(v, i)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table><script src="/js/print.js"></script></body></html>`;
}

module.exports = { build, toXlsx, toHtml };
