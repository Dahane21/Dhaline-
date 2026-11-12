import { get, esc, money, pct, qty, table, chart, palette, shortMoney, today, badge } from '../core.js';

export async function render(el) {
  const month = sessionStorage.getItem('cbm-month') || today().slice(0, 7);
  const d = await get(`/api/dashboard?month=${month}`);
  const k = d.kpis; const p = palette();
  const kpi = (lbl, val, hint = '', cls = '') => `<div class="kpi ${cls}"><div class="lbl">${esc(lbl)}</div><div class="val ${typeof val === 'number' && val < 0 ? 'neg' : ''}">${typeof val === 'number' ? money(val) : val}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  el.innerHTML = `
  <div class="page-head"><div><h1>Dashboard gerencial</h1><div class="sub">Estado del negocio en ${esc(month)} · se actualiza con cada operación registrada</div></div>
    <div class="actions"><label class="f">Mes<input type="month" id="m" value="${esc(month)}"></label></div></div>
  ${d.demo ? '<div class="demo-banner" style="margin-bottom:14px">Hay <b>datos de demostración</b> cargados. Elimínelos en Configuración → Datos antes de registrar operaciones reales.</div>' : ''}
  <div class="kpis">
    ${kpi('Utilidad neta del mes', k.net_income, `Margen neto ${pct(k.net_margin)}`, 'hero')}
    ${kpi('Ventas netas', k.net_sales)}${kpi('Costo de ventas', k.cogs)}${kpi('Utilidad bruta', k.gross_profit)}${kpi('Gastos operativos', k.opex, 'Neto de MO/CIF imputados')}
    ${kpi('Dinero disponible', k.cash, 'Efectivo + Yape + Plin + banco')}${kpi('Inventario valorizado', k.inventory)}
    ${kpi('Por cobrar', k.receivables)}${kpi('Por pagar', k.payables)}
    ${kpi('Punto de equilibrio', k.be_sales === null ? '—' : money(k.be_sales), `Avance ${pct(k.be_progress)} de los costos fijos`)}
  </div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>Ventas netas y utilidad · 12 meses</h2></div><div class="chart-box"><canvas id="c-series" aria-label="Ventas netas, utilidad bruta y utilidad neta por mes"></canvas></div></div>
    <div class="card"><div class="card-head"><h2>Avance hacia el punto de equilibrio</h2></div>
      ${d.breakeven.fixed > 0 ? `<p class="muted small">Costos fijos del mes: <b>${money(d.breakeven.fixed)}</b>. Equilibrio con la mezcla actual: <b>${qty(d.breakeven.be_units, 1)}</b> unidades de venta (${money(d.breakeven.be_sales)}).</p>
      <div class="progress" role="img" aria-label="Avance ${pct(d.breakeven.progress)}"><i style="width:${Math.min(100, d.breakeven.progress * 100)}%"></i></div>
      <div class="kv" style="margin-top:12px"><dt>Vendidas este mes</dt><dd>${qty(d.breakeven.current_units)} (${money(d.breakeven.current_sales)})</dd><dt>Margen de contribución cubierto</dt><dd>${pct(d.breakeven.progress)}</dd></div>`
      : '<div class="empty">Registre sus costos fijos mensuales en <a href="#/equilibrio">Punto de equilibrio</a> para ver el avance.</div>'}
      <h3 style="margin-top:18px">Dinero por cuenta</h3>${table([{ label: 'Cuenta', key: 'name' }, { label: 'Saldo', cls: 'n', render: r => money(r.balance) }], d.money)}</div>
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Costos y gastos del mes</h2></div><div class="chart-box sm"><canvas id="c-costs"></canvas></div></div>
    <div class="card"><div class="card-head"><h2>Distribución de gastos</h2></div><div class="chart-box sm"><canvas id="c-exp"></canvas></div><div class="legend" id="l-exp"></div></div>
    <div class="card"><div class="card-head"><h2>Inventario disponible</h2></div><div class="chart-box sm"><canvas id="c-inv"></canvas></div></div>
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Rentabilidad por producto · 90 días</h2></div><div class="chart-box sm"><canvas id="c-prod"></canvas></div></div>
    <div class="card"><div class="card-head"><h2>Ventas por calidad · mes</h2></div><div class="chart-box sm"><canvas id="c-q"></canvas></div><div class="legend" id="l-q"></div></div>
    <div class="card"><div class="card-head"><h2>Alertas</h2><div class="actions"><a class="btn sm" href="#/alertas">Ver todas</a></div></div>
      ${d.alerts.length ? d.alerts.map(a => `<div class="alert-row">${badge(a.level, a.level === 'alta' ? 'bad' : a.level === 'media' ? 'warn' : '')}<div><b>${esc(a.type)}</b><div class="small muted">${esc(a.msg)}</div></div></div>`).join('') : '<div class="empty">Sin alertas.</div>'}</div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Más vendidos del mes</h2></div>${table([{ label: 'Producto / presentación', key: 'name' }, { label: 'Unidades', cls: 'n', render: r => qty(r.qty) }, { label: 'Ventas', cls: 'n', render: r => money(r.total) }], d.top_sold, { empty: 'Aún no hay ventas este mes.' })}</div>
    <div class="card"><div class="card-head"><h2>Más rentables · 90 días</h2></div>${table([{ label: 'Producto / presentación', key: 'key' }, { label: 'Ingreso', cls: 'n', render: r => money(r.revenue) }, { label: 'Margen', cls: 'n', render: r => money(r.margin) }, { label: '%', cls: 'n', render: r => pct(r.margin_pct) }], d.top_profitable, { empty: 'Aún no hay ventas.' })}</div>
  </div>`;
  el.querySelector('#m').onchange = e => { sessionStorage.setItem('cbm-month', e.target.value); window.dispatchEvent(new Event('cbm:reload')); };

  const mlabel = m => new Date(m + '-15').toLocaleDateString('es-PE', { month: 'short' });
  const line = (label, data, color) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .25 });
  chart(el.querySelector('#c-series'), { type: 'line', legend: true, fmt: shortMoney, data: { labels: d.series.map(s => mlabel(s.month)), datasets: [line('Ventas netas', d.series.map(s => s.net_sales), p.series[0]), line('Utilidad bruta', d.series.map(s => s.gross_profit), p.series[1]), line('Utilidad neta', d.series.map(s => s.net_income), p.series[2])] } });
  const bars = (labels, data, color) => ({ labels, datasets: [{ data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26, label: 'S/' }] });
  chart(el.querySelector('#c-costs'), { type: 'bar', indexAxis: 'y', fmt: shortMoney, data: bars(d.costs.map(c => c.label), d.costs.map(c => c.value), p.series[0]) });
  chart(el.querySelector('#c-inv'), { type: 'bar', indexAxis: 'y', fmt: shortMoney, data: bars(d.inventory.rows.map(r => r.label), d.inventory.rows.map(r => r.value), p.series[1]) });
  const prod = d.by_product.slice(0, 6);
  chart(el.querySelector('#c-prod'), { type: 'bar', indexAxis: 'y', fmt: shortMoney, data: { labels: prod.map(r => r.key), datasets: [{ label: 'Margen', data: prod.map(r => r.margin), backgroundColor: p.series[0], borderRadius: 4, maxBarThickness: 22 }] } });
  const donut = (canvas, legendEl, items) => {
    const top = items.slice(0, 4); const rest = items.slice(4).reduce((s, x) => s + x.value, 0); if (rest > 0) top.push({ label: 'Otros', value: rest });
    if (!top.length) { canvas.parentElement.innerHTML = '<div class="empty">Sin datos.</div>'; return; }
    chart(canvas, { type: 'doughnut', fmt: money, data: { labels: top.map(x => x.label), datasets: [{ data: top.map(x => x.value), backgroundColor: p.series, borderColor: p.surface, borderWidth: 2 }] }, options: { cutout: '62%' } });
    const tot = top.reduce((s, x) => s + x.value, 0);
    legendEl.innerHTML = top.map((x, i) => `<span><i style="background:${p.series[i]}"></i>${esc(x.label)} · ${pct(x.value / tot)}</span>`).join('');
  };
  donut(el.querySelector('#c-exp'), el.querySelector('#l-exp'), d.expenses.map(e => ({ label: e.name, value: e.amount })));
  donut(el.querySelector('#c-q'), el.querySelector('#l-q'), d.sales_by_quality.map(q => ({ label: q.key, value: q.revenue })));
}
