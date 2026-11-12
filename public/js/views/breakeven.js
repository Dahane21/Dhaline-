import { get, post, put, esc, money, pct, qty, table, canWrite, modal, field, toast, today, chart, palette, shortMoney } from '../core.js';
import { reload } from '../forms.js';

export async function render(el) {
  const month = sessionStorage.getItem('cbm-bem') || today().slice(0, 7);
  const vol = sessionStorage.getItem('cbm-bev') || '';
  const [be, fixed] = await Promise.all([get(`/api/reports/breakeven?month=${month}${vol ? '&volume=' + vol : ''}`), get('/api/fixed_costs')]);
  el.innerHTML = `<div class="page-head"><div><h1>Punto de equilibrio</h1><div class="sub">Multiproducto, ponderado por la mezcla de ventas (${esc(be.mix_source)}).</div></div>
    <div class="actions"><label class="f">Mes<input type="month" id="m" value="${esc(month)}"></label></div></div>
  <div class="kpis"><div class="kpi"><div class="lbl">Costos fijos del mes</div><div class="val">${money(be.fixed)}</div></div><div class="kpi"><div class="lbl">Margen de contribución ponderado</div><div class="val">${money(be.weighted_cm)}</div><div class="hint">por unidad de venta</div></div>
    <div class="kpi hero"><div class="lbl">Unidades de equilibrio</div><div class="val">${be.be_units === null ? '—' : qty(be.be_units, 1)}</div><div class="hint">${be.be_sales === null ? '' : 'Ventas ' + money(be.be_sales)}</div></div>
    <div class="kpi"><div class="lbl">Vendidas este mes</div><div class="val">${qty(be.current_units)}</div><div class="hint">${money(be.current_sales)}</div></div>
    <div class="kpi"><div class="lbl">Faltan</div><div class="val">${be.gap_units === null ? '—' : qty(Math.max(0, be.gap_units), 1)}</div><div class="hint">Avance ${pct(be.progress_pct)}</div></div></div>
  ${be.fixed === 0 ? '<div class="note warn" style="margin-bottom:14px">No hay costos fijos registrados: agréguelos abajo (publicidad, internet, gas, etc.) para calcular el equilibrio.</div>' : ''}
  <div class="grid g2"><div class="card"><div class="card-head"><h2>Por presentación (mezcla de ventas)</h2></div>${table([{ label: 'Presentación', key: 'name' }, { label: 'Precio', cls: 'n', render: k => money(k.price) }, { label: 'Costo var.', cls: 'n', render: k => money(k.var_cost) }, { label: 'Margen contrib.', cls: 'n', render: k => `${money(k.cm)} <span class="small muted">${pct(k.cm_pct)}</span>` }, { label: 'Mezcla', cls: 'n', render: k => pct(k.mix) }, { label: 'Equilibrio', cls: 'n', render: k => k.be_units === null ? '—' : qty(k.be_units, 1) }, { label: 'Si solo esta', cls: 'n', render: k => k.single_be_units === null ? 'no cubre' : qty(k.single_be_units, 1) }, { label: 'Vendidas', cls: 'n', render: k => qty(k.current_units) }], be.skus, { empty: 'Defina presentaciones con precio o registre ventas.' })}
    <p class="small muted">Costo variable = costo real promedio de lo vendido (o costo estimado de la presentación si aún no hay ventas) + comisión de pago configurada (${qty(be.commission_pct)}%).</p></div>
    <div class="card"><div class="card-head"><h2>Avance hacia el equilibrio</h2></div><div class="progress"><i style="width:${Math.min(100, be.progress_pct * 100)}%"></i></div><p class="small muted">Margen de contribución acumulado del mes: ${money(be.current_contribution)} de ${money(be.fixed)}.</p>
      <div class="form-section">Escenarios</div><div class="filters"><label class="f">Volumen esperado (unidades/mes)<input type="number" id="vol" value="${esc(be.base_volume)}"></label></div>
      ${table([{ label: 'Escenario', render: s => `<b>${esc(s.name)}</b><div class="small muted">vol ×${s.factors.vol} · costo ×${s.factors.cost}</div>` }, { label: 'Unidades', cls: 'n', render: s => qty(s.units, 1) }, { label: 'Ventas', cls: 'n', render: s => money(s.revenue) }, { label: 'Contribución', cls: 'n', render: s => money(s.contribution) }, { label: 'Utilidad', cls: 'n', render: s => money(s.profit) }], be.scenarios)}
      <div class="chart-box sm"><canvas id="c"></canvas></div></div></div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Costos fijos mensuales</h2><div class="actions">${canWrite() ? '<button class="btn sm" id="nf">+ Costo fijo</button>' : ''}</div></div>${table([{ label: 'Concepto', key: 'name' }, { label: 'Mensual', cls: 'n', render: r => money(r.monthly_amount) }, { label: 'Activo', render: r => r.active ? 'Sí' : 'No' }, { label: '', render: r => canWrite() ? `<button class="btn sm" data-f="${r.id}">Editar</button>` : '' }], fixed)}</div>`;
  el.querySelector('#m').onchange = e => { sessionStorage.setItem('cbm-bem', e.target.value); reload(); };
  el.querySelector('#vol').onchange = e => { sessionStorage.setItem('cbm-bev', e.target.value); reload(); };
  const ff = (r = { active: 1 }) => modal({ title: 'Costo fijo', body: `<div class="form-grid">${field('name', 'Concepto', { value: r.name })}${field('monthly_amount', 'Monto mensual', { type: 'number', value: r.monthly_amount })}${field('active', 'Activo', { type: 'checkbox', value: r.active })}</div>`, onSubmit: async (f, v) => { r.id ? await put(`/api/fixed_costs/${r.id}`, v) : await post('/api/fixed_costs', v); toast('Guardado', 'ok'); reload(); } });
  el.querySelector('#nf')?.addEventListener('click', () => ff());
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => ff(fixed.find(x => x.id === Number(b.dataset.f))));
  const p = palette();
  chart(el.querySelector('#c'), { type: 'bar', fmt: shortMoney, data: { labels: be.scenarios.map(s => s.name), datasets: [{ label: 'Utilidad', data: be.scenarios.map(s => s.profit), backgroundColor: be.scenarios.map(s => s.profit >= 0 ? p.series[1] : p.series[0]), borderRadius: 4, maxBarThickness: 40 }] } });
}
