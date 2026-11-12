import { get, esc, badge } from '../core.js';
export async function render(el) {
  const a = await get('/api/alerts');
  el.innerHTML = `<div class="page-head"><div><h1>Alertas y control</h1><div class="sub">Se calculan en tiempo real desde los movimientos registrados.</div></div></div>
  <div class="card">${a.length ? a.map(x => `<div class="alert-row">${badge(x.level, x.level === 'alta' ? 'bad' : x.level === 'media' ? 'warn' : '')}<div style="flex:1"><b>${esc(x.type)}</b><div class="small muted">${esc(x.msg)}</div></div>${x.link ? `<a class="btn sm" href="#/${esc(x.link)}">Ir</a>` : ''}</div>`).join('') : '<div class="empty">Todo en orden: sin alertas.</div>'}</div>
  <p class="small muted">Umbrales configurables en Configuración: días para vencimiento, unidades de segunda acumuladas y % de merma por lote. El stock mínimo se define en cada insumo y los presupuestos en Finanzas.</p>`;
}
