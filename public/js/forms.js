// Formularios de operaciones reutilizables (pantallas de módulos y Registro rápido usan los mismos).
import { state, get, post, put, esc, money, money4, qty, field, options, moneyOptions, catOptions, linesEditor, modal, toast, label, today } from './core.js';

const reload = () => window.dispatchEvent(new Event('cbm:reload'));
const UNITS = { g: ['g', 'kg'], ml: ['ml', 'l'], und: ['und', 'docena', 'ciento'], m: ['m', 'cm'] };
const FACT = { g: 1, kg: 1000, ml: 1, l: 1000, und: 1, docena: 12, ciento: 100, m: 1, cm: 0.01 };
export const unitFactor = (it, u) => (u === 'pres' ? it?.pres_size : FACT[u]) || 1;
const unitOpts = (it, sel) => options([...(UNITS[it?.base_unit] || ['und']).map(u => ({ id: u, name: u })), ...(it?.pres_size ? [{ id: 'pres', name: it.pres_label || 'presentación' }] : [])], { selected: sel });
const num = v => (v === '' || v === null || v === undefined ? null : Number(v));

// ---------- Insumo ----------
export function itemForm(item = {}, onSaved) {
  const isNew = !item.id;
  modal({
    title: isNew ? 'Nuevo insumo' : `Editar: ${item.name}`,
    body: `<div class="form-grid">
      ${field('name', 'Nombre', { value: item.name, required: true, wide: true })}
      ${field('type', 'Tipo de inventario', { type: 'select', opts: options(state.meta.item_types.map(t => ({ id: t, name: label(t) })), { selected: item.type || 'materia_prima' }), help: 'Herramientas y moldes se registran como activos desde Compras.' })}
      ${field('category', 'Categoría', { value: item.category, help: 'Ej. Frutos secos, Cintas y lazos' })}
      ${field('base_unit', 'Unidad de control', { type: 'select', opts: options([['g', 'gramos (g)'], ['ml', 'mililitros (ml)'], ['und', 'unidades (und)'], ['m', 'metros (m)']].map(([id, name]) => ({ id, name })), { selected: item.base_unit || 'g' }) })}
      ${field('pres_label', 'Presentación de compra', { value: item.pres_label, help: 'Ej. "bolsa 250 g"' })}
      ${field('pres_size', 'Contenido de la presentación', { type: 'number', value: item.pres_size, help: 'En la unidad de control (ej. 250)' })}
      ${field('min_stock', 'Stock mínimo (alerta)', { type: 'number', value: item.min_stock ?? 0 })}
      ${isNew ? field('ref_price', 'Precio histórico de referencia (S/)', { type: 'number', help: 'Por presentación; no genera stock ni dinero' }) : ''}
      ${field('aliases', 'Alias (para registro rápido)', { value: item.aliases, help: 'Separados por coma', wide: true })}
      ${field('notes', 'Notas', { type: 'textarea', value: item.notes, wide: true })}
      ${!isNew ? field('active', 'Activo', { type: 'checkbox', value: item.active }) : ''}</div>`,
    onSubmit: async (f, v) => {
      if (!isNew) v.active = f.querySelector('[name=active]').checked;
      const r = isNew ? await post('/api/items', v) : await put(`/api/items/${item.id}`, v);
      toast('Insumo guardado', 'ok'); onSaved ? onSaved(r.id) : reload();
    },
  });
}

// ---------- Compra ----------
export async function purchaseForm(prefill = {}, onDone) {
  const [items, suppliers] = await Promise.all([get('/api/items'), get('/api/suppliers')]);
  const byId = id => items.find(i => String(i.id) === String(id));
  const blank = () => ({ kind: 'inventario', item_id: '', qty: '', unit: '', unit_price: '', total: '' });
  const ctl = modal({
    title: 'Registrar compra', wide: true, submit: 'Registrar compra',
    body: `<div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: prefill.date || today(), required: true })}
      ${field('supplier_id', 'Proveedor', { type: 'select', opts: options(suppliers.filter(s => s.active), { empty: '— Sin proveedor —', selected: prefill.supplier_id }) })}
      ${field('pay_status', 'Pago', { type: 'select', opts: options([{ id: 'pagado', name: 'Pagado' }, { id: 'credito', name: 'Al crédito (por pagar)' }], { selected: prefill.pay_status || 'pagado' }) })}
      ${field('account_code', 'Medio de pago', { type: 'select', opts: moneyOptions(prefill.account_code || '1101') })}
      ${field('voucher_type', 'Comprobante', { type: 'select', opts: options(['Ninguno', 'Boleta', 'Factura', 'Ticket', 'Recibo'].map(x => ({ id: x, name: x })), { selected: prefill.voucher_type || 'Ninguno' }) })}
      ${field('voucher_number', 'N.º comprobante', { value: prefill.voucher_number })}
      ${field('notes', 'Observaciones', { wide: true, value: prefill.notes })}</div>
      <div class="form-section">Productos comprados</div>
      <p class="small muted">Insumos, empaques y suministros ingresan al <b>inventario</b> (no son gasto hasta consumirse). Herramientas y moldes van a <b>activos</b>. Use "gasto directo" solo para lo que se consume en el acto.</p>
      <div id="lines"></div><div class="summary" style="margin-top:12px"><div><span>Total de la compra</span><b id="tot">S/ 0.00</b></div></div>
      <div style="margin-top:8px"><button type="button" class="btn sm" id="new-item">+ Crear insumo nuevo</button></div>`,
    onSubmit: async (f, v) => {
      const lines = ed.get().filter(l => l.item_id || l.description || l.qty).map(l => ({ ...l, qty: num(l.qty), unit_price: num(l.unit_price), total: num(l.total) }));
      if (v.pay_status === 'credito') delete v.account_code;
      const r = await post('/api/purchases', { ...v, lines });
      toast('Compra registrada: inventario y caja actualizados', 'ok'); onDone ? onDone(r) : reload();
    },
  });
  const cols = [
    { key: 'kind', label: 'Tipo', type: 'select', width: '130px', options: r => options([{ id: 'inventario', name: 'Inventario' }, { id: 'activo', name: 'Herramienta/activo' }, { id: 'gasto', name: 'Gasto directo' }], { selected: r.kind }) },
    { key: 'item_id', label: 'Insumo / descripción', type: 'select', options: r => r.kind === 'inventario' ? options(items.filter(i => i.active), { empty: 'Seleccione…', selected: r.item_id, text: i => `${i.name} (${i.base_unit})` }) : '', onSet: (r, v) => { const it = byId(v); if (it && !r.unit) r.unit = it.pres_size ? 'pres' : it.base_unit; } },
    { key: 'description', label: 'Descripción', placeholder: 'Para activos o gastos' },
    { key: 'qty', label: 'Cantidad', type: 'number', width: '90px' },
    { key: 'unit', label: 'Unidad', type: 'select', width: '110px', options: r => r.kind === 'inventario' ? unitOpts(byId(r.item_id), r.unit) : options([{ id: 'und', name: 'und' }]) },
    { key: 'unit_price', label: 'P. unitario', type: 'number', width: '95px', placeholder: 'o importe' },
    { key: 'total', label: 'Importe', type: 'number', width: '95px' },
    { key: 'expense_category', label: 'Cat. gasto', type: 'select', width: '120px', options: r => r.kind === 'gasto' ? catOptions(r.expense_category || 'operativo') : '<option value="">—</option>' },
    { label: 'Costo por unidad base', calc: r => { const it = byId(r.item_id); const t = num(r.total) ?? (num(r.unit_price) * num(r.qty)); const bq = num(r.qty) * unitFactor(it, r.unit); return r.kind === 'inventario' && it && t && bq ? `${money4(t / bq)}/${it.base_unit}` : ''; } },
  ];
  const ed = linesEditor(ctl.root.querySelector('#lines'), { columns: cols, rows: prefill.lines || [], blank, onChange: data => {
    const t = data.reduce((s, l) => s + (num(l.total) ?? (num(l.unit_price) || 0) * (num(l.qty) || 0)), 0);
    ctl.root.querySelector('#tot').textContent = money(t);
  } });
  ed.render(); ctl.root.querySelector('#lines').dispatchEvent(new Event('input'));
  ctl.root.querySelector('#new-item').onclick = () => itemForm({}, async (id) => { const fresh = await get('/api/items'); items.splice(0, items.length, ...fresh); const data = ed.get(); const empty = data.find(l => !l.item_id && l.kind === 'inventario'); const it = byId(id); if (empty) { empty.item_id = id; empty.unit = it.base_unit; } else data.push({ kind: 'inventario', item_id: id, unit: it.base_unit }); ed.set(data); });
  return ctl;
}

// ---------- Lote de producción ----------
export async function batchForm(prefill = {}, onDone) {
  const [items, products, recipes, campaigns] = await Promise.all([get('/api/items'), get('/api/products'), get('/api/recipes'), get('/api/campaigns')]);
  const Q = state.meta.qualities.filter(q => q.active);
  const byId = id => items.find(i => String(i.id) === String(id));
  const ctl = modal({
    title: 'Registrar lote de producción', wide: true, submit: 'Registrar lote',
    body: `<div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: prefill.date || today(), required: true })}
      ${field('product_id', 'Producto', { type: 'select', opts: options(products.filter(p => p.active), { empty: 'Seleccione…', selected: prefill.product_id }) })}
      ${field('recipe_id', 'Ficha técnica (opcional)', { type: 'select', opts: options(recipes.filter(r => r.active), { empty: '— Sin receta —', selected: prefill.recipe_id }), help: 'Carga los insumos escalados; puede editarlos' })}
      ${field('qty_produced', 'Cantidad producida', { type: 'number', value: prefill.qty_produced, required: true })}
      ${field('minutes', 'Tiempo (min)', { type: 'number', value: prefill.minutes || 0 })}
      ${field('labor_cost', 'Mano de obra (S/)', { type: 'number', value: prefill.labor_cost || 0, help: 'Imputada al costo del lote' })}
      ${field('overhead_cost', 'Costos indirectos (S/)', { type: 'number', value: prefill.overhead_cost || 0, help: 'Gas, luz, etc. asignables' })}
      ${field('allocation_method', 'Método de asignación de costo', { type: 'select', opts: options(Object.entries(state.meta.allocation_methods).map(([id, name]) => ({ id, name })), { selected: state.meta.settings.allocation_method }) })}
      ${field('campaign_id', 'Campaña', { type: 'select', opts: options(campaigns, { empty: '— Ninguna —' }) })}
      ${field('expiry_date', 'Vence (opcional)', { type: 'date', help: 'Por defecto: fecha + vida útil del producto' })}
      ${field('notes', 'Notas', { wide: true })}</div>
      <div class="form-section">Insumos utilizados (se descuentan del inventario a costo promedio)</div><div id="cons"></div>
      <div class="form-section">Control de calidad</div>
      <div class="form-grid" id="outs">${Q.map(q => field(`q_${q.id}`, `${q.name}${q.sellable ? '' : ' (merma)'}`, { type: 'number', value: prefill.outputs?.[q.code] ?? '', help: q.description || '' })).join('')}</div>
      <div class="form-section">Costeo en vivo</div><div id="preview" class="summary"><div><span>Complete los datos</span><b>—</b></div></div>`,
    onSubmit: async (f, v) => {
      const body = { ...v, consumptions: ed.get().filter(c => c.item_id && num(c.qty) > 0).map(c => ({ item_id: Number(c.item_id), qty: num(c.qty) * unitFactor(byId(c.item_id), c.unit || byId(c.item_id)?.base_unit) })),
        outputs: Q.map(q => ({ quality_id: q.id, qty: Number(v[`q_${q.id}`] || 0) })) };
      Q.forEach(q => delete body[`q_${q.id}`]);
      const r = await post('/api/batches', body); toast('Lote registrado: inventario descontado y producto terminado en stock', 'ok'); onDone ? onDone(r) : reload();
    },
  });
  const f = ctl.root;
  const ed = linesEditor(f.querySelector('#cons'), {
    rows: (prefill.consumptions || []).map(c => ({ item_id: c.item_id || '', qty: c.qty ?? '', unit: byId(c.item_id)?.base_unit || '' })),
    blank: () => ({ item_id: '', qty: '', unit: '' }),
    columns: [
      { key: 'item_id', label: 'Insumo', type: 'select', options: r => options(items.filter(i => i.active), { empty: 'Seleccione…', selected: r.item_id, text: i => `${i.name} · stock ${qty(i.stock_qty)} ${i.base_unit}` }), onSet: (r, v) => { r.unit = byId(v)?.base_unit || ''; } },
      { key: 'qty', label: 'Cantidad', type: 'number', width: '110px' },
      { key: 'unit', label: 'Unidad', type: 'select', width: '100px', options: r => unitOpts(byId(r.item_id), r.unit) },
      { label: 'Costo', calc: r => { const it = byId(r.item_id); return it && num(r.qty) ? money4(num(r.qty) * unitFactor(it, r.unit || it.base_unit) * (it.avg_cost || 0)) : ''; } },
    ], onChange: () => preview(),
  });
  let timer;
  const preview = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const v = Object.fromEntries([...f.querySelectorAll('.modal-body > .form-grid [name], #outs [name]')].map(e => [e.name, e.value]));
    if (!num(v.qty_produced) || !v.product_id) return;
    try {
      const p = await post('/api/batches/preview', { ...v, consumptions: ed.get().filter(c => c.item_id && num(c.qty) > 0).map(c => ({ item_id: c.item_id, qty: num(c.qty) * unitFactor(byId(c.item_id), c.unit || byId(c.item_id)?.base_unit) })), outputs: Q.map(q => ({ quality_id: q.id, qty: Number(v[`q_${q.id}`] || 0) })) });
      const sum = Q.reduce((s, q) => s + Number(v[`q_${q.id}`] || 0), 0);
      const short = p.lines.filter(l => l.short);
      f.querySelector('#preview').innerHTML = `<div><span>Materiales</span><b>${money(p.materials)}</b></div><div><span>Costo total del lote</span><b>${money(p.total)}</b></div>
        <div><span>Costo por unidad producida</span><b>${money4(p.unit_cost_produced)}</b></div>
        ${p.outputs.filter(o => o.qty > 0).map(o => { const q = Q.find(x => x.id === o.quality_id); return `<div><span>${esc(q?.name)} (${o.qty})</span><b>${q?.sellable ? money4(o.unit_cost) + '/u' : 'merma'}</b></div>`; }).join('')}
        ${p.theoretical !== null ? `<div><span>Costo teórico (receta)</span><b>${money(p.theoretical)}</b></div><div><span>Variación real vs teórico</span><b>${money(p.total - p.theoretical)}</b></div>` : ''}
        ${sum !== Number(v.qty_produced) ? `<div class="wide note warn" style="grid-column:1/-1">La clasificación suma ${sum}; debe sumar ${v.qty_produced}.</div>` : ''}
        ${short.length ? `<div class="note bad" style="grid-column:1/-1">Stock insuficiente: ${short.map(s => esc(s.name)).join(', ')}. Registre primero la compra.</div>` : ''}`;
    } catch (e) { f.querySelector('#preview').innerHTML = `<div class="note bad" style="grid-column:1/-1">${esc(e.message)}</div>`; }
  }, 250); };
  f.addEventListener('input', e => { if (!e.target.closest('#cons')) preview(); });
  f.querySelector('[name=recipe_id]').addEventListener('change', async e => {
    const rid = e.target.value; if (!rid) return;
    const rc = recipes.find(r => String(r.id) === rid);
    const qp = num(f.querySelector('[name=qty_produced]').value) || rc.yield_qty;
    f.querySelector('[name=qty_produced]').value = qp; f.querySelector('[name=product_id]').value = rc.product_id;
    const scale = qp / rc.yield_qty;
    ed.set(rc.lines.map(l => ({ item_id: l.item_id, qty: Math.round(l.qty * scale * 1000) / 1000, unit: l.base_unit })));
    f.querySelector('[name=labor_cost]').value = Math.round(rc.labor * scale * 100) / 100; f.querySelector('[name=overhead_cost]').value = Math.round(rc.overhead * scale * 100) / 100;
    f.querySelector('[name=minutes]').value = Math.round(rc.labor_minutes * scale);
    preview();
  });
  preview();
  return ctl;
}

// ---------- Venta / pedido ----------
export async function saleForm(sale = {}, onDone) {
  const [products, presentations, customers, campaigns, fg, packs] = await Promise.all([get('/api/products'), get('/api/presentations'), get('/api/customers'), get('/api/campaigns'), get('/api/fg/stock'), get('/api/packs/stock')]);
  const Q = state.meta.qualities.filter(q => q.sellable && q.active);
  const isEdit = !!sale.id;
  const stockOf = (pid, qid) => fg.find(s => s.product_id === Number(pid) && s.quality_id === Number(qid))?.qty || 0;
  const unitsOf = qid => fg.filter(s => s.quality_id === Number(qid)).reduce((s, x) => s + x.qty, 0);
  const priceOf = (l) => l.kind === 'presentacion' ? presentations.find(p => String(p.id) === String(l.presentation_id))?.price : products.find(p => String(p.id) === String(l.product_id))?.prices?.[l.quality_id];
  const channels = (state.meta.settings.channels || '').split(',').filter(Boolean);
  const ctl = modal({
    title: isEdit ? `Editar pedido ${sale.code}` : 'Nueva venta / pedido', wide: true, submit: isEdit ? 'Guardar cambios' : 'Registrar',
    body: `<div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: sale.date || today(), required: true })}
      ${field('customer_id', 'Cliente', { type: 'select', opts: options(customers, { empty: '— Sin cliente —', selected: sale.customer_id }) })}
      ${field('channel', 'Canal', { type: 'select', opts: options(channels.map(c => ({ id: c, name: c })), { empty: '—', selected: sale.channel }) })}
      ${field('campaign_id', 'Campaña', { type: 'select', opts: options(campaigns, { empty: '— Ninguna —', selected: sale.campaign_id }) })}
      ${!isEdit ? field('status', 'Estado', { type: 'select', opts: options(state.meta.statuses.filter(s => s !== 'cancelado').map(s => ({ id: s, name: label(s) })), { selected: sale.status || 'pendiente' }), help: 'Listo/Entregado descuenta stock y registra la venta' }) : ''}
      ${field('discount', 'Descuento del pedido (S/)', { type: 'number', value: sale.discount || 0 })}
      ${field('delivery_charge', 'Delivery cobrado al cliente', { type: 'number', value: sale.delivery_charge || 0 })}
      ${field('delivery_cost', 'Delivery pagado por el negocio', { type: 'number', value: sale.delivery_cost || 0, help: 'Se registra como gasto al entregar' })}
      ${field('delivery_account', 'Delivery pagado con', { type: 'select', opts: moneyOptions(sale.delivery_account || '1101') })}
      ${field('notes', 'Notas', { wide: true, value: sale.notes })}</div>
      <div class="form-section">Productos</div><div id="lines"></div>
      ${!isEdit ? `<div class="form-section">Cobro (opcional)</div><div class="form-grid">${field('pay_amount', 'Monto cobrado ahora', { type: 'number', value: sale.payment?.amount ?? '' })}${field('pay_account', 'Medio', { type: 'select', opts: moneyOptions(sale.payment?.account_code || '1102') })}${field('pay_commission', 'Comisión del medio', { type: 'number', value: 0 })}</div>` : ''}
      <div class="summary" style="margin-top:12px" id="sum"></div>`,
    onSubmit: async (f, v) => {
      const body = { ...v, lines: ed.get().filter(l => l.product_id || l.presentation_id).map(l => ({ ...l, qty: num(l.qty), unit_price: num(l.unit_price), discount: num(l.discount) || 0 })) };
      if (!isEdit && num(v.pay_amount) > 0) body.payment = { amount: num(v.pay_amount), account_code: v.pay_account, commission: num(v.pay_commission) || 0 };
      ['pay_amount', 'pay_account', 'pay_commission'].forEach(k => delete body[k]);
      const r = isEdit ? await put(`/api/sales/${sale.id}`, body) : await post('/api/sales', body);
      toast(isEdit ? 'Pedido actualizado' : 'Venta registrada', 'ok'); onDone ? onDone(r) : reload();
    },
  });
  const f = ctl.root;
  const ed = linesEditor(f.querySelector('#lines'), {
    rows: (sale.lines || []).map(l => ({ kind: l.kind, product_id: l.product_id || '', quality_id: l.quality_id || Q[0]?.id, presentation_id: l.presentation_id || '', qty: l.qty ?? '', unit_price: l.unit_price ?? '', discount: l.discount || 0 })),
    blank: () => ({ kind: 'presentacion', product_id: '', quality_id: Q[0]?.id, presentation_id: '', qty: 1, unit_price: '', discount: 0 }),
    columns: [
      { key: 'kind', label: 'Tipo', type: 'select', width: '120px', options: r => options([{ id: 'presentacion', name: 'Presentación' }, { id: 'producto', name: 'Unidad suelta' }], { selected: r.kind }), onSet: r => { r.product_id = ''; r.presentation_id = ''; r.unit_price = ''; } },
      { key: 'presentation_id', label: 'Presentación / producto', type: 'select', options: r => r.kind === 'presentacion'
        ? options(presentations.filter(p => p.active), { empty: 'Seleccione…', selected: r.presentation_id, text: p => `${p.name} · ${money(p.price)} · ${packs.find(x => x.presentation_id === p.id)?.qty || 0} armadas` })
        : options(products.filter(p => p.active), { empty: 'Seleccione…', selected: r.product_id, text: p => `${p.name}` }),
        onSet: (r, v) => { if (r.kind === 'presentacion') r.presentation_id = v; else { r.product_id = v; r.presentation_id = ''; } const p = priceOf(r); if (p !== undefined) r.unit_price = p; } },
      { key: 'quality_id', label: 'Calidad', type: 'select', width: '150px', options: r => r.kind === 'producto' ? options(Q, { selected: r.quality_id }) : '<option value="">(según presentación)</option>', onSet: (r) => { const p = priceOf(r); if (p !== undefined) r.unit_price = p; } },
      { key: 'qty', label: 'Cant.', type: 'number', width: '70px' },
      { key: 'unit_price', label: 'Precio', type: 'number', width: '85px' },
      { key: 'discount', label: 'Desc.', type: 'number', width: '70px' },
      { label: 'Stock', calc: r => r.kind === 'producto' ? (r.product_id ? `${stockOf(r.product_id, r.quality_id)} und` : '') : (r.presentation_id ? `${packs.find(x => x.presentation_id === Number(r.presentation_id))?.qty || 0} armadas · ${unitsOf(presentations.find(p => p.id === Number(r.presentation_id))?.quality_id)} sueltas` : '') },
      { label: 'Subtotal', calc: r => money((num(r.qty) || 0) * (num(r.unit_price) || 0) - (num(r.discount) || 0)) },
    ],
    onChange: () => summary(),
  });
  const summary = () => {
    const rows = ed.get(); const sub = rows.reduce((s, r) => s + (num(r.qty) || 0) * (num(r.unit_price) || 0) - (num(r.discount) || 0), 0);
    const disc = num(f.querySelector('[name=discount]').value) || 0, del = num(f.querySelector('[name=delivery_charge]').value) || 0;
    const below = rows.filter(r => { const lp = priceOf(r); return lp !== undefined && num(r.unit_price) < lp; });
    f.querySelector('#sum').innerHTML = `<div><span>Subtotal</span><b>${money(sub)}</b></div><div><span>Descuento</span><b>${money(disc)}</b></div><div><span>Delivery cobrado</span><b>${money(del)}</b></div><div><span>Total a cobrar</span><b>${money(sub - disc + del)}</b></div>
      ${below.length ? '<div class="note warn" style="grid-column:1/-1">Hay líneas con precio menor al de lista: se registrarán como precio pactado.</div>' : ''}`;
  };
  f.addEventListener('input', summary); summary();
  return ctl;
}

// ---------- Gasto ----------
export async function expenseForm(prefill = {}, onDone) {
  const [suppliers, campaigns] = await Promise.all([get('/api/suppliers'), get('/api/campaigns')]);
  return modal({
    title: 'Registrar gasto', submit: 'Registrar gasto',
    body: `<p class="small muted">Los gastos afectan el resultado del periodo. Las compras de insumos no van aquí: regístrelas en Compras para que entren al inventario.</p><div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: prefill.date || today() })}
      ${field('category', 'Categoría', { type: 'select', opts: catOptions(prefill.category || 'operativo') })}
      ${field('description', 'Descripción', { value: prefill.description, wide: true })}
      ${field('amount', 'Monto (S/)', { type: 'number', value: prefill.amount ?? '' })}
      ${field('pay_status', 'Estado', { type: 'select', opts: options([{ id: 'pagado', name: 'Pagado' }, { id: 'pendiente', name: 'Pendiente (por pagar)' }]) })}
      ${field('account_code', 'Medio de pago', { type: 'select', opts: moneyOptions(prefill.account_code || '1101') })}
      ${field('supplier_id', 'Proveedor', { type: 'select', opts: options(suppliers, { empty: '—' }) })}
      ${field('campaign_id', 'Campaña', { type: 'select', opts: options(campaigns, { empty: '—' }) })}
      ${field('voucher', 'Comprobante', {})}</div>`,
    onSubmit: async (f, v) => { if (v.pay_status === 'pendiente') delete v.account_code; await post('/api/expenses', v); toast('Gasto registrado', 'ok'); onDone ? onDone() : reload(); },
  });
}

// ---------- Consumo directo de insumo ----------
export async function consumptionForm(prefill = {}, onDone) {
  const items = await get('/api/items');
  return modal({
    title: 'Consumo directo de inventario', submit: 'Registrar consumo',
    body: `<p class="small muted">Para usos fuera de un lote o de un armado de cajas (muestras, pruebas, insumos dañados). Se descuenta a costo promedio. Para decorar cajas use <b>Armar cajas</b> en Presentaciones.</p><div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: prefill.date || today() })}
      ${field('item_id', 'Insumo', { type: 'select', opts: options(items, { empty: 'Seleccione…', selected: prefill.item_id, text: i => `${i.name} · stock ${qty(i.stock_qty)} ${i.base_unit}` }) })}
      ${field('qty', 'Cantidad (unidad de control)', { type: 'number', value: prefill.qty ?? '' })}
      ${field('destination', 'Destino', { type: 'select', opts: options([{ id: 'gasto', name: 'Gasto del periodo' }, { id: 'merma', name: 'Merma / pérdida' }], { selected: prefill.destination }) })}
      ${field('expense_category', 'Categoría de gasto', { type: 'select', opts: catOptions(prefill.expense_category || 'operativo') })}
      ${field('notes', 'Motivo / detalle', { wide: true, value: prefill.notes })}</div>`,
    onSubmit: async (f, v) => { await post('/api/inventory/consumptions', v); toast('Consumo registrado', 'ok'); onDone ? onDone() : reload(); },
  });
}

// ---------- Cobro ----------
export function paymentForm(sale, onDone) {
  return modal({
    title: `Registrar cobro · ${sale.code}`, submit: 'Registrar cobro',
    body: `<p class="small muted">Saldo pendiente: <b>${money(sale.balance)}</b>. Use un monto negativo para registrar un reembolso.</p><div class="form-grid">
      ${field('date', 'Fecha', { type: 'date', value: today() })}${field('amount', 'Monto', { type: 'number', value: sale.balance > 0 ? sale.balance : '' })}
      ${field('account_code', 'Medio', { type: 'select', opts: moneyOptions('1102') })}${field('commission', 'Comisión del medio (S/)', { type: 'number', value: 0 })}${field('notes', 'Notas', { wide: true })}</div>`,
    onSubmit: async (f, v) => { await post(`/api/sales/${sale.id}/payments`, v); toast('Cobro registrado', 'ok'); onDone ? onDone() : reload(); },
  });
}
export { reload };
