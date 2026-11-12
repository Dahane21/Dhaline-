import { get, post, esc, money, money4, qty, table, label, badge, canWrite, modal, field, options, today, toast, askReason, statusBadge } from '../core.js';
import { itemForm, consumptionForm, purchaseForm, reload } from '../forms.js';

export async function render(el, [tab0]) {
  const tab = tab0 || sessionStorage.getItem('cbm-invtab') || 'materia_prima';
  const [items, value, assets, cons, counts] = await Promise.all([get('/api/items'), get('/api/inventory/value'), get('/api/assets'), get('/api/inventory/consumptions'), get('/api/inventory/counts')]);
  const tabs = [['materia_prima', 'Materia prima'], ['empaque', 'Empaques'], ['suministro', 'Suministros'], ['activos', 'Herramientas y activos'], ['consumos', 'Consumos directos'], ['conteos', 'Conteos físicos']];
  el.innerHTML = `<div class="page-head"><div><h1>Inventario</h1><div class="sub">Valorizado a costo promedio ponderado. Cada movimiento queda en el kárdex.</div></div>
    <div class="actions">${canWrite() ? '<button class="btn" id="open">Inventario inicial</button><button class="btn" id="count">Conteo físico</button><button class="btn" id="cons">Consumo directo</button><button class="btn" id="buy">Registrar compra</button><button class="btn primary" id="new">+ Nuevo insumo</button>' : ''}</div></div>
  <div class="kpis">${value.rows.map(r => `<div class="kpi"><div class="lbl">${esc(r.label)}</div><div class="val">${money(r.value)}</div></div>`).join('')}<div class="kpi hero"><div class="lbl">Total valorizado</div><div class="val">${money(value.total)}</div></div></div>
  <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
  <div class="card" id="body"></div>`;
  const body = el.querySelector('#body');
  if (['materia_prima', 'empaque', 'suministro'].includes(tab)) {
    const rows = items.filter(i => i.type === tab);
    body.innerHTML = `<div class="filters"><label class="f">Buscar<input id="q" placeholder="Nombre o categoría"></label></div><div id="tbl"></div>`;
    const draw = (q = '') => body.querySelector('#tbl').innerHTML = table([
      { label: 'Insumo', render: r => `<b>${esc(r.name)}</b>${r.active ? '' : ' ' + badge('inactivo')}<div class="small muted">${esc(r.category || '')}</div>` },
      { label: 'Stock', cls: 'n', render: r => `${qty(r.stock_qty)} ${esc(r.base_unit)}${r.pres_size && r.stock_qty ? `<div class="small muted">≈ ${qty(r.stock_qty / r.pres_size, 2)} × ${esc(r.pres_label)}</div>` : ''}` },
      { label: 'Costo promedio', cls: 'n', render: r => `${money4(r.avg_cost)}/${esc(r.base_unit)}` },
      { label: 'Valor', cls: 'n', render: r => money(r.stock_value) },
      { label: 'Precio ref. / último', cls: 'n', render: r => r.ref_price ? `${money(r.ref_price.pres_price)} <span class="small muted">${esc(r.ref_price.pres_label || '')}</span>` : '—' },
      { label: 'Mínimo', cls: 'n', render: r => r.min_stock ? `${qty(r.min_stock)} ${r.stock_qty <= r.min_stock ? badge('bajo', 'bad') : ''}` : '—' },
      { label: '', render: r => `<button class="btn sm" data-k="${r.id}">Kárdex</button> ${canWrite() ? `<button class="btn sm ghost" data-e="${r.id}">Editar</button>` : ''}` },
    ], rows.filter(r => !q || (r.name + ' ' + (r.category || '')).toLowerCase().includes(q.toLowerCase())), { empty: 'No hay insumos de este tipo.' });
    draw(); body.querySelector('#q').oninput = e => draw(e.target.value);
  } else if (tab === 'activos') {
    body.innerHTML = `<p class="small muted">Moldes, utensilios y equipos: son inversión, no costo de producción ni gasto del mes. Se registran desde Compras con tipo "Herramienta/activo".</p>` + table([
      { label: 'Fecha', key: 'date' }, { label: 'Activo', render: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.capacity || '')} ${esc(r.notes || '')}</div>` }, { label: 'Categoría', key: 'category' },
      { label: 'Cant.', cls: 'n', render: r => qty(r.qty) }, { label: 'Costo', cls: 'n', render: r => money(r.total_cost) }, { label: 'Estado', render: r => statusBadge(r.status) }], assets);
  } else if (tab === 'consumos') {
    body.innerHTML = table([{ label: 'Fecha', key: 'date' }, { label: 'Insumo', key: 'name' }, { label: 'Cantidad', cls: 'n', render: r => `${qty(r.qty)} ${esc(r.base_unit)}` }, { label: 'Costo', cls: 'n', render: r => money(r.cost) },
      { label: 'Destino', render: r => esc(r.destination === 'merma' ? 'Merma' : 'Gasto ' + label(r.expense_category)) }, { label: 'Detalle', key: 'notes' }, { label: 'Estado', render: r => statusBadge(r.status) },
      { label: '', render: r => r.status === 'activo' && canWrite() ? `<button class="btn sm danger" data-an="${r.id}">Anular</button>` : '' }], cons, { rowAttr: r => r.status !== 'activo' ? 'class="annulled"' : '' });
  } else {
    body.innerHTML = `<p class="small muted">Las diferencias entre el conteo físico y el sistema se registran como ajuste auditable (mermas y ajustes de inventario).</p>` + table([{ label: 'Fecha', key: 'date' }, { label: 'Insumo', key: 'name' }, { label: 'Sistema', cls: 'n', render: r => qty(r.system_qty) }, { label: 'Físico', cls: 'n', render: r => qty(r.counted_qty) }, { label: 'Diferencia', cls: 'n', render: r => `${qty(r.diff_qty)} ${esc(r.base_unit || '')}` }, { label: 'Valor ajuste', cls: 'n', render: r => money(r.diff_value) }, { label: 'Notas', key: 'notes' }], counts);
  }
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { sessionStorage.setItem('cbm-invtab', b.dataset.tab); location.hash = '#/inventario/' + b.dataset.tab; });
  el.querySelector('#new')?.addEventListener('click', () => itemForm({ type: ['materia_prima', 'empaque', 'suministro'].includes(tab) ? tab : 'materia_prima' }));
  el.querySelector('#buy')?.addEventListener('click', () => purchaseForm());
  el.querySelector('#cons')?.addEventListener('click', () => consumptionForm());
  el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => itemForm(items.find(i => i.id === Number(b.dataset.e))));
  el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => kardex(Number(b.dataset.k)));
  el.querySelectorAll('[data-an]').forEach(b => b.onclick = async () => { const reason = await askReason('Anular consumo'); try { await post(`/api/inventory/consumptions/${b.dataset.an}/annul`, { reason }); reload(); } catch (e) { toast(e.message, 'bad'); } });
  el.querySelector('#count')?.addEventListener('click', () => modal({ title: 'Conteo físico', submit: 'Registrar conteo', body: `<div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('item_id', 'Insumo', { type: 'select', opts: options(items, { empty: 'Seleccione…', text: i => `${i.name} · sistema ${qty(i.stock_qty)} ${i.base_unit}` }) })}${field('counted_qty', 'Cantidad contada (unidad de control)', { type: 'number' })}${field('notes', 'Notas', { wide: true, help: 'Ej. "pesé la cobertura congelada sobrante"' })}</div>`,
    onSubmit: async (f, v) => { const r = await post('/api/inventory/counts', v); toast(r.diff ? `Ajuste registrado: ${qty(r.diff)} (${money(r.value)})` : 'Sin diferencias', 'ok'); reload(); } }));
  el.querySelector('#open')?.addEventListener('click', () => modal({ title: 'Inventario inicial (saldo de apertura)', submit: 'Registrar saldo', body: `<p class="small muted">Para insumos que ya tenía antes de usar el sistema. Se valoriza con el costo que usted indique y se registra contra "Saldos de apertura" (no es compra ni gasto del mes). Si fue donado, valor 0.</p><div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('item_id', 'Insumo', { type: 'select', opts: options(items, { empty: 'Seleccione…', text: i => `${i.name} (${i.base_unit})` }) })}${field('qty', 'Cantidad (unidad de control)', { type: 'number' })}${field('total_cost', 'Valor total (S/)', { type: 'number' })}${field('notes', 'Notas', { wide: true })}</div>`,
    onSubmit: async (f, v) => { await post('/api/inventory/opening', v); toast('Saldo inicial registrado', 'ok'); reload(); } }));
}

async function kardex(id) {
  const k = await get(`/api/items/${id}/kardex`);
  modal({ title: `Kárdex: ${k.item.name}`, wide: true, cancel: 'Cerrar', body: `<div class="kv"><dt>Stock</dt><dd>${qty(k.item.stock_qty)} ${esc(k.item.base_unit)}</dd><dt>Valor</dt><dd>${money(k.item.stock_value)}</dd></div>
    <div class="form-section">Movimientos (promedio ponderado)</div>${table([{ label: 'Fecha', key: 'date' }, { label: 'Movimiento', render: r => esc(r.type.replace(/_/g, ' ')) }, { label: 'Entrada', cls: 'n', render: r => r.qty > 0 ? qty(r.qty) : '' }, { label: 'Salida', cls: 'n', render: r => r.qty < 0 ? qty(-r.qty) : '' }, { label: 'C. unit.', cls: 'n', render: r => money4(r.unit_cost) }, { label: 'C. total', cls: 'n', render: r => money(r.total_cost) }, { label: 'Saldo', cls: 'n', render: r => qty(r.balance_qty) }, { label: 'Valor', cls: 'n', render: r => money(r.balance_value) }, { label: 'Ref.', render: r => esc(`${r.ref_type || ''} ${r.note || ''}`) }, { label: 'Usuario', key: 'username' }], k.movements)}
    <div class="form-section">Historial de precios</div>${table([{ label: 'Fecha', key: 'date' }, { label: 'Origen', key: 'source' }, { label: 'Presentación', key: 'pres_label' }, { label: 'Precio', cls: 'n', render: r => money(r.pres_price) }, { label: 'Por unidad base', cls: 'n', render: r => money4(r.unit_cost) }], k.prices)}` });
}
