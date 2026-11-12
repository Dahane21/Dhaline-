import { state, post, esc, money, qty, table, badge, label, moneyName, canWrite } from '../core.js';
import { purchaseForm, batchForm, saleForm, expenseForm, consumptionForm, itemForm } from '../forms.js';

const EXAMPLES = ['Hoy compré 2 kg de cobertura a S/ 32 y 50 cajas pequeñas a S/ 40', 'Utilicé 300 gramos de cobertura, 200 gramos de manjar y 20 pecanas para producir 25 chocotejas', 'Compré cintas rojas por S/ 12 y utilicé 8 metros para decorar las cajas navideñas', 'Vendí 10 chocotejas originales a S/ 4 y 5 defectuosas a S/ 2.50 por Yape', 'Compré utensilios por S/ 35 para el emprendimiento'];
const TYPE = { compra: 'Compra', produccion: 'Producción', venta: 'Venta', gasto: 'Gasto', consumo: 'Consumo de inventario', aporte: 'Aporte de capital' };

export async function render(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Registro rápido</h1><div class="sub">Escriba lo que hizo. El sistema lo interpreta con reglas locales, le muestra una vista previa editable y <b>solo registra cuando usted confirma</b>.</div></div></div>
  <div class="card"><div class="quick-input"><textarea id="t" placeholder="Ej.: Hoy compré 1 kg de manjar a S/ 18 por Yape" aria-label="Operación en lenguaje natural"></textarea></div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn primary" id="go">Interpretar</button><span class="small muted" style="align-self:center">No inventa precios, cantidades ni consumos: lo que falte se le preguntará.</span></div>
    <div class="examples small" style="margin-top:12px"><span class="muted">Ejemplos:</span><br>${EXAMPLES.map((e, i) => `<button class="btn sm ghost" data-ex="${i}">${esc(e)}</button>`).join('')}</div></div>
  <div id="res"></div>`;
  const t = el.querySelector('#t');
  el.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { t.value = EXAMPLES[b.dataset.ex]; go(); });
  el.querySelector('#go').onclick = go; t.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go(); });
  async function go() {
    if (!t.value.trim()) return;
    const res = el.querySelector('#res');
    try { const r = await post('/api/quick/parse', { text: t.value }); show(res, r); }
    catch (e) { res.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
  }
}

function show(res, r) {
  const d = r.draft;
  let detail = '';
  if (d?.kind === 'compra') detail = table([{ label: 'Tipo', render: l => esc(label(l.kind)) }, { label: 'Producto', render: l => l.item_name ? esc(l.item_name) : l.new_item ? `${esc(l.new_item.name)} ${badge('nuevo', 'warn')}` : esc(l.description) }, { label: 'Cantidad', cls: 'n', render: l => l.qty === null ? badge('falta', 'bad') : `${qty(l.qty)} ${esc(l.unit || '')}` }, { label: 'P. unit.', cls: 'n', render: l => l.unit_price === null ? '—' : money(l.unit_price) }, { label: 'Importe', cls: 'n', render: l => l.total === null ? (l.unit_price === null ? badge('falta', 'bad') : '—') : money(l.total) }], d.lines);
  if (d?.kind === 'produccion') detail = `<p>Producto: <b>${esc(d.product_name || '¿?')}</b> · Cantidad: <b>${d.qty_produced ?? '¿?'}</b></p>` + table([{ label: 'Insumo', render: c => esc(c.item_name || c.phrase) }, { label: 'Cantidad (unidad de control)', cls: 'n', render: c => c.qty === null ? badge('falta', 'bad') : qty(c.qty) }], d.consumptions);
  if (d?.kind === 'venta') detail = table([{ label: 'Producto', render: l => esc(l.name || '¿?') }, { label: 'Calidad', render: l => esc(l.quality || (l.kind === 'presentacion' ? 'según presentación' : '¿?')) }, { label: 'Cant.', cls: 'n', render: l => qty(l.qty) }, { label: 'Precio', cls: 'n', render: l => l.unit_price === null ? badge('falta', 'bad') : money(l.unit_price) }], d.lines) + (d.payment ? `<p class="small">Cobro: ${esc(moneyName(d.payment.account_code))}</p>` : '');
  if (d?.kind === 'gasto') detail = `<div class="kv"><dt>Monto</dt><dd>${d.amount === null ? 'falta' : money(d.amount)}</dd><dt>Categoría</dt><dd>${esc(label(d.category || '¿?'))}</dd></div>`;
  if (r.consumption) detail += `<div class="form-section">Consumo indicado</div>` + table([{ label: 'Insumo', render: c => esc(c.item_name || '¿?') }, { label: 'Cantidad', cls: 'n', render: c => c.qty === null ? badge('falta', 'bad') : `${qty(c.qty)} ${esc(c.unit || '')}` }, { label: 'Para', render: c => esc(c.purpose) }], r.consumption.lines);
  res.innerHTML = `<div class="card"><div class="card-head"><h2>Vista previa: ${esc(TYPE[r.type] || 'No identificada')}</h2>${badge(r.date)}</div>${detail}
    ${r.questions.length ? `<div class="form-section">Necesito confirmar</div><ul>${r.questions.map(q => `<li>${esc(q.q)}</li>`).join('')}</ul>` : ''}
    ${r.warnings.length ? `<div class="note warn">${r.warnings.map(esc).join('<br>')}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">${canWrite() && d ? '<button class="btn primary" id="open">Revisar, completar y confirmar</button>' : ''}${r.consumption && canWrite() ? '<button class="btn" id="cons">Registrar el consumo después</button>' : ''}</div>
    <p class="small muted" style="margin-top:8px">Se abre el formulario del módulo con los datos detectados. Nada se registra hasta que pulse el botón del formulario.</p></div>`;
  res.querySelector('#open')?.addEventListener('click', () => openForm(r));
  res.querySelector('#cons')?.addEventListener('click', () => { const c = r.consumption.lines[0]; if (r.consumption.destination === 'armado') location.hash = '#/presentaciones'; else consumptionForm({ date: r.date, item_id: c.item_id, qty: c.base_qty ?? c.qty ?? '' }); });
}

function openForm(r) {
  const d = r.draft; const Q = state.meta.qualities;
  if (d.kind === 'compra') {
    const pending = d.lines.find(l => l.new_item && !l.item_id);
    if (pending) return itemForm({ ...pending.new_item, active: 1 }, (id) => { pending.item_id = id; pending.item_name = pending.new_item.name; pending.new_item = null; openForm(r); });
    return purchaseForm({ date: d.date, account_code: d.account_code, pay_status: d.pay_status, lines: d.lines.map(l => ({ kind: l.kind, item_id: l.item_id || '', description: l.description, qty: l.qty ?? '', unit: l.unit || '', unit_price: l.unit_price ?? '', total: l.total ?? '', expense_category: 'operativo' })) });
  }
  if (d.kind === 'produccion') return batchForm({ date: d.date, product_id: d.product_id, qty_produced: d.qty_produced, consumptions: d.consumptions.filter(c => c.item_id).map(c => ({ item_id: c.item_id, qty: c.qty ?? '' })) });
  if (d.kind === 'venta') return saleForm({ date: d.date, status: d.status, lines: d.lines.map(l => ({ kind: l.kind, product_id: l.product_id || d.product_hint?.id || '', presentation_id: l.presentation_id || '', quality_id: l.quality_id || Q.find(q => q.code === 'A')?.id, qty: l.qty, unit_price: l.unit_price ?? '' })), payment: d.payment ? { account_code: d.payment.account_code, amount: d.lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0) } : null });
  if (d.kind === 'gasto') return expenseForm({ date: d.date, amount: d.amount, category: d.category, description: d.description, account_code: d.account_code });
  if (d.kind === 'consumo') { const c = d.lines[0] || {}; return consumptionForm({ date: d.date, item_id: c.item_id, qty: c.base_qty ?? c.qty ?? '' }); }
  if (d.kind === 'aporte') location.hash = '#/finanzas/socias';
}
