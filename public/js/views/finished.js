import { state, get, post, put, esc, money, money4, qty, pct, table, badge, canWrite, isAdmin, modal, field, options, toast, today } from '../core.js';
import { reload } from '../forms.js';

export async function render(el) {
  const [stock, lots, products] = await Promise.all([get('/api/fg/stock'), get('/api/fg/lots'), get('/api/products')]);
  const Q = state.meta.qualities;
  const sellQ = Q.filter(q => q.sellable && q.active);
  el.innerHTML = `<div class="page-head"><div><h1>Productos terminados</h1><div class="sub">Stock independiente por producto y calidad, con trazabilidad por lote de producción.</div></div>
    <div class="actions">${canWrite() ? '<button class="btn" id="open">Saldo inicial</button><button class="btn primary" id="prod">+ Producto</button>' : ''}</div></div>
  <div class="card"><div class="card-head"><h2>Stock disponible para venta</h2></div>${table([
    { label: 'Producto', key: 'product' }, { label: 'Calidad', render: r => badge(r.quality, r.code === 'A' ? 'ok' : 'warn') }, { label: 'Unidades', cls: 'n', render: r => qty(r.qty) },
    { label: 'Costo prom.', cls: 'n', render: r => money4(r.avg_cost) }, { label: 'Valor', cls: 'n', render: r => money(r.value) }, { label: 'Precio', cls: 'n', render: r => money(r.price) },
    { label: 'Margen/u', cls: 'n', render: r => `${money(r.price - r.avg_cost)} <span class="small muted">${pct(r.price ? (r.price - r.avg_cost) / r.price : 0)}</span>` },
    { label: 'Próx. vence', key: 'next_expiry' }], stock, { empty: 'No hay productos terminados en stock.' })}</div>
  <div class="card"><div class="card-head"><h2>Comparativo original vs segunda</h2></div>${compare(stock)}</div>
  <div class="card"><div class="card-head"><h2>Lotes con stock</h2></div>${table([
    { label: 'Lote PT', key: 'id' }, { label: 'Lote prod.', key: 'batch_code' }, { label: 'Producto', key: 'product' }, { label: 'Calidad', key: 'quality' }, { label: 'Disp./Inicial', cls: 'n', render: r => `${qty(r.qty_available)} / ${qty(r.qty_initial)}` },
    { label: 'Costo/u', cls: 'n', render: r => money4(r.unit_cost) }, { label: 'Vence', render: r => `${esc(r.expiry_date || '')} ${r.expiry_date && r.expiry_date < today() ? badge('vencido', 'bad') : ''}` },
    { label: '', render: r => canWrite() ? `<button class="btn sm" data-adj="${r.id}">Ajustar</button>` : '' }], lots, { empty: 'Sin lotes con stock.' })}</div>
  <div class="card"><div class="card-head"><h2>Productos y precios por calidad</h2><div class="actions"><span class="small muted">Cambiar un precio no altera el costo histórico.</span></div></div>${table([
    { label: 'Producto', render: r => `<b>${esc(r.name)}</b> ${r.active ? '' : badge('inactivo')}<div class="small muted">${esc(r.family || '')} · vida útil ${r.shelf_life_days} días</div>` },
    ...sellQ.map(q => ({ label: q.name, cls: 'n', render: r => r.prices[q.id] !== undefined ? money(r.prices[q.id]) : '<span class="muted">por definir</span>' })),
    { label: '', render: r => canWrite() ? `<button class="btn sm" data-e="${r.id}">Editar</button>` : '' }], products)}</div>
  <div class="card"><div class="card-head"><h2>Categorías de calidad</h2>${isAdmin() ? '<div class="actions"><button class="btn sm" id="newq">+ Categoría</button></div>' : ''}</div>${table([
    { label: 'Código', key: 'code' }, { label: 'Nombre', key: 'name' }, { label: 'Descripción', key: 'description' }, { label: 'Comercializable', render: r => r.sellable ? badge('Sí', 'ok') : badge('No (merma)', 'bad') },
    { label: 'Factor de costo', cls: 'n', render: r => qty(r.cost_factor) }, { label: '', render: r => isAdmin() ? `<button class="btn sm" data-q="${r.id}">Editar</button>` : '' }], Q)}
    <p class="small muted">El factor de costo se usa con el método "Ponderado por factor": p. ej. 0.6 significa que una unidad de segunda absorbe el 60% del costo de una original.</p></div>`;

  const prodForm = (p = { prices: {}, shelf_life_days: 15 }) => modal({ title: p.id ? `Editar ${p.name}` : 'Nuevo producto', body: `<div class="form-grid">${field('name', 'Nombre', { value: p.name, wide: true })}${field('family', 'Familia', { value: p.family, help: 'Chocotejas, Bombones, Temporada…' })}${field('shelf_life_days', 'Vida útil (días)', { type: 'number', value: p.shelf_life_days, help: 'Pendiente: probar cuántos días duran' })}
    ${sellQ.map(q => field(`price_${q.id}`, `Precio ${q.name} (S/)`, { type: 'number', value: p.prices[q.id] ?? '' })).join('')}${field('aliases', 'Alias', { value: p.aliases, wide: true })}${p.id ? field('active', 'Activo', { type: 'checkbox', value: p.active }) : ''}</div>`,
    onSubmit: async (f, v) => { const prices = {}; sellQ.forEach(q => { prices[q.id] = v[`price_${q.id}`]; delete v[`price_${q.id}`]; }); const body = { ...v, prices, active: p.id ? f.querySelector('[name=active]').checked : true }; p.id ? await put(`/api/products/${p.id}`, body) : await post('/api/products', body); toast('Producto guardado', 'ok'); reload(); } });
  el.querySelector('#prod')?.addEventListener('click', () => prodForm());
  el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => prodForm(products.find(p => p.id === Number(b.dataset.e))));
  const qForm = (q = { sellable: 1, cost_factor: 1 }) => modal({ title: q.id ? `Editar ${q.name}` : 'Nueva categoría', body: `<div class="form-grid">${field('code', 'Código', { value: q.code })}${field('name', 'Nombre', { value: q.name })}${field('cost_factor', 'Factor de costo', { type: 'number', value: q.cost_factor })}${field('sort', 'Orden', { type: 'number', value: q.sort || 0 })}${field('description', 'Descripción', { type: 'textarea', wide: true, value: q.description })}${field('sellable', 'Comercializable (ingresa a stock)', { type: 'checkbox', value: q.sellable })}</div>`,
    onSubmit: async (f, v) => { q.id ? await put(`/api/qualities/${q.id}`, v) : await post('/api/qualities', v); toast('Guardado', 'ok'); location.reload(); } });
  el.querySelector('#newq')?.addEventListener('click', () => qForm());
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => qForm(Q.find(q => q.id === Number(b.dataset.q))));
  el.querySelectorAll('[data-adj]').forEach(b => b.onclick = () => { const l = lots.find(x => x.id === Number(b.dataset.adj)); modal({ title: `Ajustar lote PT ${l.id} · ${l.product} (${l.quality})`, submit: 'Registrar ajuste',
    body: `<p class="small muted">Disponible: ${l.qty_available}. Reclasificar conserva el costo histórico del lote; una baja se registra como merma.</p><div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('action', 'Acción', { type: 'select', opts: options([{ id: 'reclasificar', name: 'Reclasificar a otra calidad' }, { id: 'merma', name: 'Dar de baja (merma)' }]) })}${field('to_quality_id', 'Nueva calidad', { type: 'select', opts: options(Q.filter(q => q.id !== l.quality_id)) })}${field('qty', 'Cantidad', { type: 'number' })}${field('reason', 'Motivo', { wide: true })}</div>`,
    onSubmit: async (f, v) => { await post('/api/fg/adjust', { ...v, lot_id: l.id }); toast('Ajuste registrado', 'ok'); reload(); } }); });
  el.querySelector('#open')?.addEventListener('click', () => modal({ title: 'Saldo inicial de producto terminado', submit: 'Registrar', body: `<p class="small muted">Para chocotejas ya elaboradas antes de usar el sistema (ej. 5 sueltas, 2 cuadrados, 5 defectuosas). Indique el costo unitario estimado de ingredientes.</p><div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('product_id', 'Producto', { type: 'select', opts: options(products, { empty: 'Seleccione…' }) })}${field('quality_id', 'Calidad', { type: 'select', opts: options(sellQ) })}${field('qty', 'Cantidad', { type: 'number' })}${field('unit_cost', 'Costo unitario (S/)', { type: 'number' })}${field('expiry_date', 'Vence', { type: 'date' })}${field('notes', 'Notas', { wide: true })}</div>`,
    onSubmit: async (f, v) => { await post('/api/fg/opening', v); toast('Saldo inicial registrado', 'ok'); reload(); } }));
}

function compare(stock) {
  const by = {};
  for (const s of stock) { by[s.product] = by[s.product] || {}; by[s.product][s.code] = s; }
  const rows = Object.entries(by).filter(([, v]) => v.A && v.B).map(([product, v]) => ({ product, a: v.A, b: v.B }));
  if (!rows.length) return '<div class="empty">Se muestra cuando hay stock original y de segunda del mismo producto.</div>';
  return table([{ label: 'Producto', key: 'product' }, { label: 'Precio original', cls: 'n', render: r => money(r.a.price) }, { label: 'Precio segunda', cls: 'n', render: r => money(r.b.price) },
    { label: 'Costo segunda', cls: 'n', render: r => money4(r.b.avg_cost) }, { label: 'Recupera de su costo', cls: 'n', render: r => pct(r.b.avg_cost ? r.b.price / r.b.avg_cost : 0) },
    { label: 'Margen sacrificado/u', cls: 'n', render: r => money(r.a.price - r.b.price) }, { label: 'Si vende todo el stock de segunda', cls: 'n', render: r => `${money(r.b.qty * r.b.price)} <span class="small muted">(deja de ganar ${money(r.b.qty * (r.a.price - r.b.price))})</span>` }], rows);
}
