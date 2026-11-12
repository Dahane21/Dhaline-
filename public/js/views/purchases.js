import { get, post, esc, money, qty, table, statusBadge, label, askReason, toast, canWrite, monthStart, today, modal, field, options, moneyOptions } from '../core.js';
import { purchaseForm, reload } from '../forms.js';

export async function render(el) {
  const f = JSON.parse(sessionStorage.getItem('cbm-pf') || 'null') || { from: monthStart(), to: today() };
  const [rows, suppliers, pays] = await Promise.all([get(`/api/purchases?from=${f.from}&to=${f.to}`), get('/api/suppliers'), get('/api/supplier-payments')]);
  const active = rows.filter(r => r.status === 'activa');
  const sum = k => active.flatMap(r => r.lines).filter(l => l.kind === k).reduce((s, l) => s + l.total, 0);
  el.innerHTML = `<div class="page-head"><div><h1>Compras</h1><div class="sub">Cada compra incrementa el inventario o los activos y registra el desembolso (o la deuda) una sola vez.</div></div>
    <div class="actions">${canWrite() ? '<button class="btn" id="pay">Pagar a proveedor</button><button class="btn primary" id="new">+ Nueva compra</button>' : ''}</div></div>
  <div class="filters"><label class="f">Desde<input type="date" id="from" value="${f.from}"></label><label class="f">Hasta<input type="date" id="to" value="${f.to}"></label></div>
  <div class="kpis"><div class="kpi"><div class="lbl">A inventario</div><div class="val">${money(sum('inventario'))}</div></div><div class="kpi"><div class="lbl">A herramientas / activos</div><div class="val">${money(sum('activo'))}</div></div><div class="kpi"><div class="lbl">Gasto directo</div><div class="val">${money(sum('gasto'))}</div></div><div class="kpi"><div class="lbl">Al crédito</div><div class="val">${money(active.filter(r => r.pay_status === 'credito').reduce((s, r) => s + r.total, 0))}</div></div></div>
  <div class="card">${table([
    { label: 'Código', key: 'code' }, { label: 'Fecha', key: 'date' }, { label: 'Proveedor', render: r => esc(r.supplier || '—') },
    { label: 'Detalle', render: r => r.lines.map(l => `${esc(l.item_name || l.description)} <span class="muted">(${qty(l.qty)} ${esc(l.unit === 'pres' ? 'pres.' : l.unit)} · ${esc(label(l.kind))})</span>`).join('<br>') },
    { label: 'Pago', render: r => `${statusBadge(r.pay_status)} <span class="small muted">${esc(r.account_code ? '' : '')}</span>` },
    { label: 'Total', cls: 'n', render: r => money(r.total) }, { label: 'Estado', render: r => statusBadge(r.status) + (r.annul_reason ? `<div class="small muted">${esc(r.annul_reason)}</div>` : '') },
    { label: '', render: r => r.status === 'activa' && canWrite() ? `<button class="btn sm danger" data-annul="${r.id}">Anular</button>` : '' },
  ], rows, { rowAttr: r => r.status !== 'activa' ? 'class="annulled"' : '', empty: 'No hay compras en este periodo.' })}</div>
  <div class="card"><div class="card-head"><h2>Pagos a proveedores</h2></div>${table([{ label: 'Fecha', key: 'date' }, { label: 'Proveedor', key: 'supplier' }, { label: 'Monto', cls: 'n', render: r => money(r.amount) }, { label: 'Estado', render: r => statusBadge(r.status) }, { label: '', render: r => r.status === 'activo' && canWrite() ? `<button class="btn sm danger" data-annulpay="${r.id}">Anular</button>` : '' }], pays, { empty: 'Sin pagos registrados.' })}</div>`;
  const save = () => { sessionStorage.setItem('cbm-pf', JSON.stringify({ from: el.querySelector('#from').value, to: el.querySelector('#to').value })); reload(); };
  el.querySelector('#from').onchange = save; el.querySelector('#to').onchange = save;
  el.querySelector('#new')?.addEventListener('click', () => purchaseForm());
  el.querySelector('#pay')?.addEventListener('click', () => modal({ title: 'Pago a proveedor', body: `<div class="form-grid">${field('date', 'Fecha', { type: 'date', value: today() })}${field('supplier_id', 'Proveedor', { type: 'select', opts: options(suppliers, { empty: 'Seleccione…' }) })}${field('amount', 'Monto', { type: 'number' })}${field('account_code', 'Medio', { type: 'select', opts: moneyOptions() })}${field('notes', 'Notas', { wide: true })}</div>`, onSubmit: async (fm, v) => { await post('/api/supplier-payments', v); toast('Pago registrado', 'ok'); reload(); } }));
  el.querySelectorAll('[data-annul]').forEach(b => b.onclick = async () => { const reason = await askReason('Anular compra', 'Se retiran del inventario las unidades compradas y se revierte el asiento. No es posible si ya se consumieron.'); try { await post(`/api/purchases/${b.dataset.annul}/annul`, { reason }); toast('Compra anulada', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
  el.querySelectorAll('[data-annulpay]').forEach(b => b.onclick = async () => { const reason = await askReason('Anular pago a proveedor'); try { await post('/api/finance/annul', { type: 'pago_proveedor', id: b.dataset.annulpay, reason }); reload(); } catch (e) { toast(e.message, 'bad'); } });
}
