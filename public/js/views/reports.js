import { get, esc, money, table, monthStart, today } from '../core.js';

const REPORTS = [
  ['ventas', 'Reporte de ventas', 'cliente, campaña, producto'], ['compras', 'Reporte de compras', 'producto, categoría'], ['kardex', 'Kárdex de inventario', 'insumo'],
  ['produccion', 'Costeo de producción', 'producto, lote'], ['fichas', 'Fichas técnicas', ''], ['resultados', 'Estado de resultados', ''], ['flujo', 'Flujo de caja', ''],
  ['inventario', 'Balance de inventario', ''], ['rentabilidad', 'Reporte de rentabilidad', ''], ['equilibrio', 'Punto de equilibrio', ''], ['defectuosos', 'Productos defectuosos y mermas', ''], ['socias', 'Aportes de las socias', ''],
];
export async function render(el) {
  const items = await get('/api/items');
  let cur = sessionStorage.getItem('cbm-rep') || 'resultados';
  el.innerHTML = `<div class="page-head"><div><h1>Reportes</h1><div class="sub">Vista previa, exportación a Excel (.xlsx) y a PDF (desde la vista de impresión del navegador).</div></div></div>
  <div class="grid" style="grid-template-columns:260px minmax(0,1fr)" id="lay"><div class="card"><nav class="nav">${REPORTS.map(([k, l]) => `<a href="javascript:void 0" data-r="${k}" class="${k === cur ? 'active' : ''}">${esc(l)}</a>`).join('')}</nav></div>
  <div class="card"><div class="filters">
    <label class="f">Desde<input type="date" id="from" value="${monthStart()}"></label><label class="f">Hasta<input type="date" id="to" value="${today()}"></label>
    <label class="f">Producto / texto<input id="product" placeholder="Filtrar"></label><label class="f">Cliente<input id="customer"></label><label class="f">Campaña<input id="campaign"></label><label class="f">Lote<input id="batch"></label>
    <label class="f">Insumo (kárdex)<select id="item_id"><option value="">Todos</option>${items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></label>
  </div><div class="card-head"><h2 id="title"></h2><div class="actions"><a class="btn" id="xlsx">Excel</a><a class="btn" id="pdf" target="_blank" rel="noopener">PDF / imprimir</a></div></div><div id="out"></div></div></div>`;
  if (matchMedia('(max-width: 860px)').matches) el.querySelector('#lay').style.gridTemplateColumns = '1fr';
  const qs = () => { const p = new URLSearchParams(); ['from', 'to', 'product', 'customer', 'campaign', 'batch', 'item_id'].forEach(k => { const v = el.querySelector('#' + k).value; if (v) p.set(k, v); }); return p; };
  const load = async () => {
    const p = qs(); const rep = await get(`/api/export/${cur}?${p}`);
    el.querySelector('#title').textContent = rep.title;
    el.querySelector('#xlsx').href = `/api/export/${cur}?${p}&format=xlsx`; el.querySelector('#pdf').href = `/api/export/${cur}?${p}&format=html`;
    el.querySelector('#out').innerHTML = table(rep.columns.map((c, i) => ({ label: c, cls: rep.rows.some(r => typeof r[i] === 'number') ? 'n' : '', render: r => typeof r[i] === 'number' ? (rep.moneyCols.includes(i) ? money(r[i]) : esc(Math.round(r[i] * 1000) / 1000)) : esc(r[i]) })), rep.rows, { empty: 'Sin datos para los filtros elegidos.' });
  };
  el.querySelectorAll('[data-r]').forEach(a => a.onclick = () => { cur = a.dataset.r; sessionStorage.setItem('cbm-rep', cur); el.querySelectorAll('[data-r]').forEach(x => x.classList.toggle('active', x === a)); load(); });
  el.querySelectorAll('.filters input, .filters select').forEach(i => i.onchange = load);
  load();
}
