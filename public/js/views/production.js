import { state, get, post, put, esc, money, money4, qty, pct, table, badge, statusBadge, canWrite, modal, field, options, linesEditor, toast, askReason, monthStart, today } from '../core.js';
import { batchForm, reload } from '../forms.js';

export async function render(el, [tab0]) {
  const tab = tab0 || 'lotes';
  el.innerHTML = `<div class="page-head"><div><h1>Producción y costeo</h1><div class="sub">Lotes con consumo real de insumos, clasificación de calidad y costo por unidad comercializable.</div></div>
    <div class="actions">${canWrite() ? '<button class="btn" id="rec">+ Ficha técnica</button><button class="btn primary" id="new">+ Registrar lote</button>' : ''}</div></div>
    <div class="tabs"><button data-tab="lotes" class="${tab === 'lotes' ? 'active' : ''}">Lotes</button><button data-tab="fichas" class="${tab === 'fichas' ? 'active' : ''}">Fichas técnicas</button></div><div id="body"></div>`;
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { location.hash = '#/produccion/' + b.dataset.tab; });
  el.querySelector('#new')?.addEventListener('click', () => batchForm());
  el.querySelector('#rec')?.addEventListener('click', () => recipeForm());
  const body = el.querySelector('#body');
  if (tab === 'fichas') return renderRecipes(body);
  const f = JSON.parse(sessionStorage.getItem('cbm-bf') || 'null') || { from: today().slice(0, 4) + '-01-01', to: today() };
  const rows = await get(`/api/batches?from=${f.from}&to=${f.to}`);
  const act = rows.filter(r => r.status === 'activo' && r.kind === 'produccion');
  const tot = k => act.reduce((s, r) => s + r[k], 0);
  body.innerHTML = `<div class="filters"><label class="f">Desde<input type="date" id="from" value="${f.from}"></label><label class="f">Hasta<input type="date" id="to" value="${f.to}"></label></div>
  <div class="kpis"><div class="kpi"><div class="lbl">Unidades producidas</div><div class="val">${qty(tot('qty_produced'))}</div></div><div class="kpi"><div class="lbl">Originales</div><div class="val">${qty(tot('approved_qty'))}</div></div><div class="kpi"><div class="lbl">De segunda</div><div class="val">${qty(tot('defect_qty'))}</div></div><div class="kpi"><div class="lbl">No comercializables</div><div class="val">${qty(tot('lost_qty'))}</div><div class="hint">Merma ${pct(tot('qty_produced') ? tot('lost_qty') / tot('qty_produced') : 0)}</div></div><div class="kpi"><div class="lbl">Costo total producido</div><div class="val">${money(tot('total_cost'))}</div></div></div>
  <div class="card">${table([
    { label: 'Lote', render: r => `<b>${esc(r.code)}</b>${r.kind === 'inicial' ? ' ' + badge('saldo inicial') : ''}` }, { label: 'Fecha', key: 'date' }, { label: 'Producto', key: 'product' },
    { label: 'Prod.', cls: 'n', render: r => qty(r.qty_produced) },
    { label: 'Calidad', render: r => r.outputs.filter(o => o.qty > 0).map(o => `${badge(`${o.code}: ${o.qty}`, o.code === 'A' ? 'ok' : o.sellable ? 'warn' : 'bad')}`).join(' ') },
    { label: 'Costo lote', cls: 'n', render: r => money(r.total_cost) }, { label: 'Costo/u comerc.', cls: 'n', render: r => money4(r.unit_cost_sellable) },
    { label: 'Merma', cls: 'n', render: r => pct(r.waste_pct) }, { label: 'vs teórico', cls: 'n', render: r => r.variance === null ? '—' : `${money(r.variance)} <span class="small muted">${pct(r.variance_pct)}</span>` },
    { label: 'Estado', render: r => statusBadge(r.status) },
  ], rows, { rowAttr: r => `class="click ${r.status !== 'activo' ? 'annulled' : ''}" data-id="${r.id}"`, empty: 'Aún no hay lotes. Registre su primera producción.' })}</div>`;
  const save = () => { sessionStorage.setItem('cbm-bf', JSON.stringify({ from: body.querySelector('#from').value, to: body.querySelector('#to').value })); reload(); };
  body.querySelector('#from').onchange = save; body.querySelector('#to').onchange = save;
  body.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => batchDetail(Number(tr.dataset.id)));
}

export async function batchDetail(id) {
  const b = await get(`/api/batches/${id}`);
  const m = modal({ title: `Lote ${b.code} · ${b.product}`, wide: true, cancel: 'Cerrar',
    extraFoot: b.status === 'activo' && canWrite() ? '<button type="button" class="btn danger left" id="an">Anular lote</button>' : '',
    body: `<div class="summary"><div><span>Fecha</span><b>${esc(b.date)}</b></div><div><span>Producidas</span><b>${b.qty_produced}</b></div><div><span>Materiales</span><b>${money(b.materials_cost)}</b></div><div><span>MO + CIF</span><b>${money(b.labor_cost + b.overhead_cost)}</b></div><div><span>Costo total</span><b>${money(b.total_cost)}</b></div><div><span>Costo/u producida</span><b>${money4(b.unit_cost_produced)}</b></div><div><span>Costo/u comercializable</span><b>${money4(b.unit_cost_sellable)}</b></div><div><span>Rendimiento</span><b>${pct(b.yield_pct)}</b></div><div><span>Merma</span><b>${pct(b.waste_pct)} (${money(b.waste_value)})</b></div><div><span>Vence</span><b>${esc(b.expiry_date || '—')}</b></div>
      ${b.theoretical_cost !== null ? `<div><span>Costo teórico</span><b>${money(b.theoretical_cost)}</b></div><div><span>Variación</span><b>${money(b.variance)} (${pct(b.variance_pct)})</b></div>` : ''}</div>
      <div class="form-section">Clasificación y costo asignado · ${esc(state.meta.allocation_methods[b.allocation_method] || b.allocation_method)}</div>
      ${table([{ label: 'Calidad', key: 'quality' }, { label: 'Cantidad', cls: 'n', key: 'qty' }, { label: 'Costo unitario', cls: 'n', render: r => r.sellable ? money4(r.unit_cost) : 'Merma (absorbida)' }, { label: 'Costo total', cls: 'n', render: r => r.sellable ? money(r.total_cost) : '—' }], b.outputs)}
      <div class="form-section">Insumos consumidos · rendimiento real vs ficha</div>
      ${table([{ label: 'Insumo', key: 'name' }, { label: 'Real', cls: 'n', render: r => `${qty(r.qty)} ${esc(r.base_unit)}` }, { label: 'Ficha', cls: 'n', render: r => r.std_qty === null ? '—' : `${qty(r.std_qty)} ${esc(r.base_unit)}` }, { label: 'Desvío', cls: 'n', render: r => r.std_qty ? pct(r.qty / r.std_qty - 1) : '—' }, { label: 'Por unidad comerc.', cls: 'n', render: r => b.sellable_qty ? `${qty(r.qty / b.sellable_qty, 3)} ${esc(r.base_unit)}` : '—' }, { label: 'Costo', cls: 'n', render: r => money(r.cost) }], b.consumptions)}
      <div class="form-section">Stock generado (trazabilidad)</div>${table([{ label: 'Lote PT', key: 'id' }, { label: 'Calidad', key: 'quality' }, { label: 'Inicial', cls: 'n', key: 'qty_initial' }, { label: 'Disponible', cls: 'n', key: 'qty_available' }, { label: 'Costo/u', cls: 'n', render: r => money4(r.unit_cost) }, { label: 'Vence', key: 'expiry_date' }], b.lots)}
      ${b.notes ? `<p class="small muted">${esc(b.notes)}</p>` : ''}${b.annul_reason ? `<div class="note bad">Anulado: ${esc(b.annul_reason)}</div>` : ''}` });
  m.root.querySelector('#an')?.addEventListener('click', async () => { m.close(); const reason = await askReason('Anular lote', 'Devuelve los insumos al inventario y retira el producto terminado (solo si no se vendió ni armó).'); try { await post(`/api/batches/${id}/annul`, { reason }); toast('Lote anulado', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
}

async function renderRecipes(body) {
  const rows = await get('/api/recipes');
  body.innerHTML = `<div class="card"><p class="small muted">Las fichas técnicas calculan el costo teórico con los precios vigentes de los insumos (promedio en stock o último precio). Los lotes ya registrados conservan su costo histórico.</p>${table([
    { label: 'Ficha', render: r => `<b>${esc(r.name)}</b>${r.is_demo ? ' ' + badge('DEMO', 'demo') : ''}<div class="small muted">${esc(r.product)} · rinde ${r.yield_qty} und</div>` },
    { label: 'Ingredientes', render: r => r.lines.map(l => `${esc(l.name)} ${qty(l.qty)} ${esc(l.base_unit)}`).join(', ') },
    { label: 'Materiales', cls: 'n', render: r => money(r.materials) }, { label: 'MO + CIF', cls: 'n', render: r => money(r.labor + r.overhead) }, { label: 'Costo lote', cls: 'n', render: r => money(r.total) }, { label: 'Costo/u', cls: 'n', render: r => money4(r.unit_cost) },
    { label: '', render: r => canWrite() ? `<button class="btn sm" data-e="${r.id}">Editar</button> <button class="btn sm primary" data-p="${r.id}">Producir</button>` : '' },
  ], rows, { empty: 'Sin fichas técnicas. Cree una para no ingresar los insumos desde cero en cada lote.' })}</div>`;
  body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => recipeForm(rows.find(r => r.id === Number(b.dataset.e))));
  body.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const r = rows.find(x => x.id === Number(b.dataset.p)); batchForm({ recipe_id: r.id, product_id: r.product_id, qty_produced: r.yield_qty, consumptions: r.lines.map(l => ({ item_id: l.item_id, qty: l.qty })), labor_cost: r.labor, overhead_cost: r.overhead, minutes: r.labor_minutes }); });
}

async function recipeForm(rc = {}) {
  const [items, products] = await Promise.all([get('/api/items'), get('/api/products')]);
  const ctl = modal({ title: rc.id ? `Editar ficha: ${rc.name}` : 'Nueva ficha técnica', wide: true,
    body: `<div class="form-grid">${field('name', 'Nombre', { value: rc.name, wide: true })}${field('product_id', 'Producto', { type: 'select', opts: options(products, { empty: 'Seleccione…', selected: rc.product_id }) })}${field('yield_qty', 'Rinde (unidades)', { type: 'number', value: rc.yield_qty })}${field('labor_minutes', 'Tiempo (min)', { type: 'number', value: rc.labor_minutes || 0 })}${field('labor_cost', 'Mano de obra (S/)', { type: 'number', value: rc.labor_cost || 0 })}${field('overhead_cost', 'Costos indirectos (S/)', { type: 'number', value: rc.overhead_cost || 0 })}${field('notes', 'Notas', { wide: true, value: rc.notes })}${rc.id ? field('active', 'Activa', { type: 'checkbox', value: rc.active }) : ''}</div>
      <div class="form-section">Ingredientes para el rendimiento indicado (en unidad de control)</div><div id="ln"></div>`,
    onSubmit: async (f, v) => { const body = { ...v, active: rc.id ? f.querySelector('[name=active]').checked : true, lines: ed.get().filter(l => l.item_id).map(l => ({ item_id: Number(l.item_id), qty: Number(l.qty) })) }; rc.id ? await put(`/api/recipes/${rc.id}`, body) : await post('/api/recipes', body); toast('Ficha guardada', 'ok'); reload(); } });
  const byId = id => items.find(i => String(i.id) === String(id));
  const ed = linesEditor(ctl.root.querySelector('#ln'), { rows: (rc.lines || []).map(l => ({ item_id: l.item_id, qty: l.qty })), blank: () => ({ item_id: '', qty: '' }), columns: [
    { key: 'item_id', label: 'Insumo', type: 'select', options: r => options(items, { empty: 'Seleccione…', selected: r.item_id, text: i => `${i.name} (${i.base_unit})` }) },
    { key: 'qty', label: 'Cantidad', type: 'number', width: '120px' },
    { label: 'Costo vigente', calc: r => { const it = byId(r.item_id); return it && r.qty ? money4(Number(r.qty) * it.avg_cost) : ''; } }] });
}
