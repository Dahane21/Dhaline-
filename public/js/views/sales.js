import { state, get, post, esc, money, money4, qty, table, badge, statusBadge, label, canWrite, isAdmin, modal, field, options, toast, askReason, monthStart, today, moneyName } from '../core.js';
import { saleForm, paymentForm, reload } from '../forms.js';

const NEXT = { pendiente: ['preparacion', 'listo', 'entregado'], preparacion: ['listo', 'entregado'], listo: ['entregado'] };
export async function render(el) {
  const f = JSON.parse(sessionStorage.getItem('cbm-sf') || 'null') || { from: monthStart(), to: today(), status: '' };
  const rows = await get(`/api/sales?from=${f.from}&to=${f.to}${f.status ? '&status=' + f.status : ''}`);
  const act = rows.filter(r => r.status !== 'cancelado');
  el.innerHTML = `<div class="page-head"><div><h1>Ventas y pedidos</h1><div class="sub">El stock y el costo de ventas se registran cuando el pedido pasa a <b>Listo</b> o <b>Entregado</b>.</div></div>
    <div class="actions">${canWrite() ? '<button class="btn primary" id="new">+ Nueva venta</button>' : ''}</div></div>
  <div class="filters"><label class="f">Desde<input type="date" id="from" value="${f.from}"></label><label class="f">Hasta<input type="date" id="to" value="${f.to}"></label>
    <label class="f">Estado<select id="st">${options(state.meta.statuses.map(s => ({ id: s, name: label(s) })), { empty: 'Todos', selected: f.status })}</select></label></div>
  <div class="kpis"><div class="kpi"><div class="lbl">Pedidos</div><div class="val">${act.length}</div></div><div class="kpi"><div class="lbl">Total vendido</div><div class="val">${money(act.reduce((s, r) => s + r.net_total, 0))}</div></div><div class="kpi"><div class="lbl">Cobrado</div><div class="val">${money(act.reduce((s, r) => s + r.paid, 0))}</div></div><div class="kpi"><div class="lbl">Por cobrar</div><div class="val">${money(act.reduce((s, r) => s + Math.max(0, r.balance), 0))}</div></div><div class="kpi"><div class="lbl">Costo de lo despachado</div><div class="val">${money(act.filter(r => r.fulfilled).reduce((s, r) => s + r.cost_total, 0))}</div></div></div>
  <div class="card">${table([
    { label: 'Pedido', render: r => `<b>${esc(r.code)}</b>${r.is_demo ? ' ' + badge('DEMO', 'demo') : ''}` }, { label: 'Fecha', key: 'date' }, { label: 'Cliente', render: r => esc(r.customer || '—') + `<div class="small muted">${esc(r.channel || '')}</div>` },
    { label: 'Productos', render: r => `<span class="small">${esc(r.items)}</span>` }, { label: 'Estado', render: r => statusBadge(r.status) }, { label: 'Pago', render: r => statusBadge(r.pay_status) },
    { label: 'Total', cls: 'n', render: r => money(r.net_total) }, { label: 'Saldo', cls: 'n', render: r => money(r.balance) }, { label: 'Margen bruto', cls: 'n', render: r => r.fulfilled ? money(r.net_total - r.delivery_charge - r.cost_total) : '—' },
  ], rows, { rowAttr: r => `class="click ${r.status === 'cancelado' ? 'annulled' : ''}" data-id="${r.id}"`, empty: 'Sin ventas en este periodo.' })}</div>`;
  const save = () => { sessionStorage.setItem('cbm-sf', JSON.stringify({ from: el.querySelector('#from').value, to: el.querySelector('#to').value, status: el.querySelector('#st').value })); reload(); };
  ['#from', '#to', '#st'].forEach(s => el.querySelector(s).onchange = save);
  el.querySelector('#new')?.addEventListener('click', () => saleForm());
  el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => saleDetail(Number(tr.dataset.id)));
}

export async function saleDetail(id) {
  const s = await get(`/api/sales/${id}`);
  const editable = !s.fulfilled && s.status !== 'cancelado';
  const m = modal({ title: `Pedido ${s.code}`, wide: true, cancel: 'Cerrar',
    extraFoot: canWrite() ? `${s.status !== 'cancelado' && s.status !== 'entregado' ? '<button type="button" class="btn danger left" id="cancel">Cancelar pedido</button>' : ''}${editable ? '<button type="button" class="btn" id="edit">Editar</button>' : ''}${s.status !== 'cancelado' ? '<button type="button" class="btn" id="pay">Registrar cobro</button>' : ''}${s.status === 'entregado' ? '<button type="button" class="btn" id="ret">Devolución</button>' : ''}${(NEXT[s.status] || []).map(n => `<button type="button" class="btn primary" data-st="${n}">→ ${esc(label(n))}</button>`).join('')}` : '',
    body: `<div class="summary"><div><span>Fecha</span><b>${esc(s.date)}</b></div><div><span>Cliente</span><b>${esc(s.customer || '—')}</b></div><div><span>Estado</span><b>${statusBadge(s.status)}</b></div><div><span>Pago</span><b>${statusBadge(s.pay_status)}</b></div>
      <div><span>Total</span><b>${money(s.net_total)}</b></div><div><span>Cobrado</span><b>${money(s.paid)}</b></div><div><span>Saldo</span><b>${money(s.balance)}</b></div><div><span>Costo de ventas</span><b>${s.fulfilled ? money(s.cost_total) : 'al despachar'}</b></div>
      ${s.fulfilled ? `<div><span>Utilidad bruta</span><b>${money(s.net_total - s.delivery_charge - s.cost_total)}</b></div>` : ''}${s.campaign ? `<div><span>Campaña</span><b>${esc(s.campaign)}</b></div>` : ''}</div>
      <div class="form-section">Detalle</div>${table([{ label: 'Producto', render: l => esc(l.presentation || `${l.product} (${l.quality})`) }, { label: 'Cant.', cls: 'n', render: l => qty(l.qty) + (l.returned_qty ? ` <span class="small muted">(−${l.returned_qty} dev.)</span>` : '') }, { label: 'Precio', cls: 'n', render: l => money(l.unit_price) + (l.list_price !== null && l.unit_price < l.list_price ? `<div class="small muted">lista ${money(l.list_price)}</div>` : '') }, { label: 'Desc.', cls: 'n', render: l => money(l.discount) }, { label: 'Total', cls: 'n', render: l => money(l.total) }, { label: 'Costo', cls: 'n', render: l => s.fulfilled ? money(l.cost_total) : '—' }, { label: 'Margen', cls: 'n', render: l => s.fulfilled ? money(l.total - l.cost_total) + (l.total < l.cost_total ? ' ' + badge('bajo costo', 'bad') : '') : '—' }], s.lines)}
      ${s.discount || s.delivery_charge ? `<p class="small">Descuento del pedido: ${money(s.discount)} · Delivery cobrado: ${money(s.delivery_charge)} · Delivery pagado: ${money(s.delivery_cost)}</p>` : ''}
      ${s.fulfilled ? `<div class="form-section">Trazabilidad (lotes de origen y empaques)</div>${table([{ label: 'Línea', render: t => esc(t.line) }, { label: 'Componente', render: t => esc(t.product || t.item) }, { label: 'Lote', render: t => esc(t.batch_code || '—') }, { label: 'Cant.', cls: 'n', render: t => qty(t.qty, 3) }, { label: 'Costo', cls: 'n', render: t => money4(t.cost) }], s.lines.flatMap(l => l.trace.map(t => ({ ...t, line: l.presentation || l.product }))))}` : ''}
      <div class="form-section">Cobros</div>${table([{ label: 'Fecha', key: 'date' }, { label: 'Medio', render: p => esc(moneyName(p.account_code)) }, { label: 'Monto', cls: 'n', render: p => money(p.amount) }, { label: 'Comisión', cls: 'n', render: p => money(p.commission) }, { label: 'Estado', render: p => statusBadge(p.status) }, { label: '', render: p => p.status === 'activo' && canWrite() ? `<button type="button" class="btn sm danger" data-anp="${p.id}">Anular</button>` : '' }], s.payments, { empty: 'Sin cobros.' })}
      ${s.returns.length ? `<div class="form-section">Devoluciones</div>${table([{ label: 'Fecha', key: 'date' }, { label: 'Cant.', cls: 'n', key: 'qty' }, { label: 'Monto', cls: 'n', render: r => money(r.amount) }, { label: 'Reingreso', render: r => r.restock ? 'Sí, a stock' : 'No (merma)' }], s.returns)}` : ''}
      ${s.cancel_reason ? `<div class="note bad">Cancelado: ${esc(s.cancel_reason)}</div>` : ''}${s.notes ? `<p class="small muted">${esc(s.notes)}</p>` : ''}` });
  const r = m.root; const after = () => { m.close(); reload(); };
  r.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
    try { await post(`/api/sales/${id}/status`, { status: b.dataset.st }); toast(`Pedido ${label(b.dataset.st)}`, 'ok'); after(); }
    catch (e) {
      if (e.detail?.code === 'stock_negativo' && isAdmin() && confirm(`${e.message}\n\n¿Autoriza registrar con stock negativo? (quedará en la auditoría)`)) { try { await post(`/api/sales/${id}/status`, { status: b.dataset.st, allow_negative: true }); after(); } catch (e2) { m.showError(e2.message); } }
      else m.showError(e.message);
    }
  });
  r.querySelector('#edit')?.addEventListener('click', () => { m.close(); saleForm(s); });
  r.querySelector('#pay')?.addEventListener('click', () => { m.close(); paymentForm(s); });
  r.querySelector('#cancel')?.addEventListener('click', async () => { m.close(); const reason = await askReason('Cancelar pedido', 'Si ya se despachó, el stock vuelve a sus lotes y se revierten los asientos. Los cobros quedan como saldo a favor (registre un reembolso si corresponde).'); try { await post(`/api/sales/${id}/status`, { status: 'cancelado', reason }); reload(); } catch (e) { toast(e.message, 'bad'); } });
  r.querySelectorAll('[data-anp]').forEach(b => b.onclick = async () => { m.close(); const reason = await askReason('Anular cobro'); try { await post(`/api/payments/${b.dataset.anp}/annul`, { reason }); reload(); } catch (e) { toast(e.message, 'bad'); } });
  r.querySelector('#ret')?.addEventListener('click', () => { m.close(); modal({ title: `Devolución · ${s.code}`, submit: 'Registrar devolución', body: `<div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('line_id', 'Producto', { type: 'select', opts: options(s.lines, { text: l => `${l.presentation || l.product} · vendidas ${l.qty - l.returned_qty}` }) })}${field('qty', 'Cantidad devuelta', { type: 'number', value: 1 })}${field('amount', 'Monto a devolver / descontar (S/)', { type: 'number' })}${field('restock', 'El producto vuelve al stock en buen estado', { type: 'checkbox', wide: true })}${field('notes', 'Motivo', { wide: true })}</div>`,
    onSubmit: async (f, v) => { await post(`/api/sales/${id}/returns`, v); toast('Devolución registrada', 'ok'); reload(); } }); });
}
