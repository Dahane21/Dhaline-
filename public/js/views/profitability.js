import { get, esc, money, pct, qty, table, chart, palette, shortMoney, monthStart, today } from '../core.js';

const DIMS = [['by_sku', 'Presentación / SKU'], ['by_product', 'Producto'], ['by_quality', 'Calidad'], ['by_batch', 'Lote'], ['by_campaign', 'Campaña'], ['by_channel', 'Canal'], ['by_customer', 'Cliente']];
export async function render(el) {
  const f = JSON.parse(sessionStorage.getItem('cbm-rf') || 'null') || { from: monthStart(), to: today(), dim: 'by_sku' };
  const [p, is] = await Promise.all([get(`/api/reports/profitability?from=${f.from}&to=${f.to}`), get(`/api/reports/income?from=${f.from}&to=${f.to}`)]);
  const rows = p[f.dim]; const sq = p.second_quality;
  el.innerHTML = `<div class="page-head"><div><h1>Rentabilidad</h1><div class="sub">Ingreso neto (descuentos y devoluciones incluidos) menos costo real de lo vendido, por la dimensión que elija.</div></div></div>
  <div class="filters"><label class="f">Desde<input type="date" id="from" value="${f.from}"></label><label class="f">Hasta<input type="date" id="to" value="${f.to}"></label><label class="f">Ver por<select id="dim">${DIMS.map(([k, l]) => `<option value="${k}" ${k === f.dim ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
  <div class="grid g2"><div class="card"><div class="card-head"><h2>Estado de resultados del periodo</h2></div><table class="t stmt"><tbody>
    <tr><td>Ventas brutas</td><td class="n">${money(is.gross_sales)}</td></tr><tr class="sub"><td>(−) Descuentos</td><td class="n">${money(-is.discounts)}</td></tr><tr class="sub"><td>(−) Devoluciones</td><td class="n">${money(-is.returns)}</td></tr>
    <tr class="total"><td>Ventas netas</td><td class="n">${money(is.net_sales)}</td></tr><tr class="sub"><td>(−) Costo de ventas</td><td class="n">${money(-is.cogs)}</td></tr>
    <tr class="total"><td>Utilidad bruta <span class="muted small">${pct(is.gross_margin)}</span></td><td class="n">${money(is.gross_profit)}</td></tr><tr class="sub"><td>(−) Mermas y ajustes</td><td class="n">${money(-is.waste)}</td></tr>
    ${is.opex.filter(o => o.amount).map(o => `<tr class="sub"><td>(−) ${esc(o.name)}</td><td class="n">${money(-o.amount)}</td></tr>`).join('')}
    ${is.applied_conversion ? `<tr class="sub"><td>(+) MO y CIF imputados aplicados a producción</td><td class="n">${money(is.applied_conversion)}</td></tr>` : ''}
    <tr class="total"><td>Utilidad operativa</td><td class="n">${money(is.operating_profit)}</td></tr>${is.financial ? `<tr class="sub"><td>(−) Gastos financieros</td><td class="n">${money(-is.financial)}</td></tr>` : ''}
    <tr class="total"><td>Utilidad neta <span class="muted small">margen ${pct(is.net_margin)}</span></td><td class="n">${money(is.net_income)}</td></tr></tbody></table>
    <p class="small muted">Las compras de inventario no aparecen aquí: solo lo consumido y vendido. Los aportes de socias tampoco son ingresos.</p></div>
  <div class="card"><div class="card-head"><h2>Productos de segunda</h2></div><div class="summary"><div><span>Unidades vendidas</span><b>${qty(sq.units)}</b></div><div><span>Ingreso</span><b>${money(sq.revenue)}</b></div><div><span>Costo</span><b>${money(sq.cost)}</b></div><div><span>Recuperación del costo</span><b>${pct(sq.recovery_pct)}</b></div><div><span>Margen obtenido</span><b>${money(sq.margin)}</b></div><div><span>Margen sacrificado vs original</span><b>${sq.sacrificed_vs_premium === null ? '—' : money(sq.sacrificed_vs_premium)}</b></div></div>
    <p class="small muted">"Sacrificado" = lo que se habría cobrado vendiendo esas unidades al precio promedio de las originales, menos lo cobrado.</p>
    <div class="chart-box sm" style="margin-top:12px"><canvas id="c"></canvas></div></div></div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>${esc(DIMS.find(d => d[0] === f.dim)[1])}</h2><span class="small muted">Ordenado por margen; los de menor margen al final.</span></div>${table([{ label: 'Elemento', key: 'key' }, { label: 'Unidades', cls: 'n', render: r => qty(r.units) }, { label: 'Ingreso neto', cls: 'n', render: r => money(r.revenue) }, { label: 'Costo', cls: 'n', render: r => money(r.cost) }, { label: 'Margen', cls: 'n', render: r => money(r.margin) }, { label: 'Margen %', cls: 'n', render: r => pct(r.margin_pct) }], rows, { empty: 'Sin ventas despachadas en el periodo.' })}
  <p class="small muted">En cajas, el ingreso se reparte entre su contenido y empaques en proporción a su costo; el empaque se carga a los productos que contiene.</p></div>`;
  const save = () => { sessionStorage.setItem('cbm-rf', JSON.stringify({ from: el.querySelector('#from').value, to: el.querySelector('#to').value, dim: el.querySelector('#dim').value })); window.dispatchEvent(new Event('cbm:reload')); };
  ['#from', '#to', '#dim'].forEach(s => el.querySelector(s).onchange = save);
  const pal = palette(); const top = rows.slice(0, 8);
  if (top.length) chart(el.querySelector('#c'), { type: 'bar', indexAxis: 'y', fmt: shortMoney, data: { labels: top.map(r => r.key), datasets: [{ label: 'Margen', data: top.map(r => r.margin), backgroundColor: pal.series[0], borderRadius: 4, maxBarThickness: 20 }] } });
  else el.querySelector('#c').parentElement.innerHTML = '<div class="empty">Sin datos para graficar.</div>';
}
