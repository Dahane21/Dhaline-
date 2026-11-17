import { get, post, esc, money, badge, statusBadge, canWrite, modal, field, moneyOptions, toast, today } from '../core.js';
import { paymentForm, reload } from '../forms.js';
import { saleDetail } from './sales.js';

const daysAgo = d => Math.round((Date.parse(today()) - Date.parse(d)) / 864e5);
const ago = d => { const n = daysAgo(d); return n <= 0 ? 'hoy' : n === 1 ? 'ayer' : `hace ${n} días`; };

export async function render(el) {
  const all = (await get('/api/sales?from=2000-01-01')).filter(s => s.status !== 'cancelado');
  const toDeliver = all.filter(s => ['pendiente', 'preparacion', 'listo'].includes(s.status)).sort((a, b) => a.date.localeCompare(b.date));
  const toCollect = all.filter(s => s.balance > 0.009).sort((a, b) => a.date.localeCompare(b.date));
  const sum = (l, k) => l.reduce((t, s) => t + s[k], 0);
  const card = (s, mode) => {
    const late = daysAgo(s.date) >= 3;
    const acts = !canWrite() ? '' : mode === 'deliver'
      ? `${s.balance > 0.009 ? `<button class="btn sm primary" data-dc="${s.id}">Entregar y cobrar</button>` : ''}<button class="btn sm${s.balance > 0.009 ? '' : ' primary'}" data-d="${s.id}">Entregado</button>${s.status === 'pendiente' ? `<button class="btn sm" data-r="${s.id}">Listo</button>` : ''}<button class="btn sm ghost" data-o="${s.id}">Ver</button>`
      : `<button class="btn sm primary" data-c="${s.id}">Cobrar ${money(s.balance)}</button><button class="btn sm ghost" data-o="${s.id}">Ver</button>`;
    return `<div class="pend ${mode === 'collect' ? 'debt' : ''} ${late ? 'late' : ''}">
      <div><div class="who">${esc(s.customer || 'Sin cliente')} <span class="small muted">${esc(s.code)}</span></div>
        <div class="what">${esc(s.items)}</div>
        <div class="meta">${statusBadge(s.status)} ${mode === 'deliver' ? (s.balance > 0.009 ? badge('por cobrar', 'warn') : badge('pagado', 'ok')) : ''}<span>${esc(ago(s.date))}</span>${late ? badge(mode === 'deliver' ? 'demorado' : 'deuda antigua', 'bad') : ''}</div></div>
      <div class="amt">${money(mode === 'collect' ? s.balance : s.net_total)}<small>${mode === 'collect' ? `de ${money(s.net_total)}` : 'total'}</small></div>
      <div class="acts">${acts}</div></div>`;
  };
  el.innerHTML = `<div class="page-head"><div><h1>Pendientes</h1><div class="sub">Lo que falta entregar y lo que falta cobrar, de lo más antiguo a lo más reciente.</div></div></div>
  <div class="kpis"><div class="kpi"><div class="lbl">Por entregar</div><div class="val">${toDeliver.length}</div><div class="hint">${money(sum(toDeliver, 'net_total'))} en pedidos</div></div>
    <div class="kpi"><div class="lbl">Por cobrar</div><div class="val">${money(sum(toCollect, 'balance'))}</div><div class="hint">${toCollect.length} pedido(s)</div></div></div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>Por entregar</h2>${badge(String(toDeliver.length), 'warn')}</div>
      <div class="pend-list">${toDeliver.map(s => card(s, 'deliver')).join('') || '<div class="empty">Nada pendiente de entrega.</div>'}</div></div>
    <div class="card"><div class="card-head"><h2>Por cobrar</h2>${badge(String(toCollect.length), 'brand')}</div>
      <div class="pend-list">${toCollect.map(s => card(s, 'collect')).join('') || '<div class="empty">Nadie te debe.</div>'}</div></div>
  </div>
  <p class="small muted">Rojo a la izquierda: tiene 3 días o más. "Listo" y "Entregado" ya cuentan como venta; el dinero entra al registrar el cobro.</p>`;
  const find = id => all.find(s => s.id === Number(id));
  const setStatus = async (id, status) => { await post(`/api/sales/${id}/status`, { status }); };
  el.querySelectorAll('[data-o]').forEach(b => b.onclick = () => saleDetail(Number(b.dataset.o)));
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => { try { await setStatus(b.dataset.r, 'listo'); toast('Pedido listo', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
  el.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { try { await setStatus(b.dataset.d, 'entregado'); toast('Pedido entregado', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => paymentForm(find(b.dataset.c)));
  el.querySelectorAll('[data-dc]').forEach(b => b.onclick = () => {
    const s = find(b.dataset.dc);
    modal({ title: `Entregar y cobrar · ${s.customer || s.code}`, submit: 'Entregado y cobrado',
      body: `<p class="small muted">${esc(s.items)}</p><div class="form-grid">${field('amount', 'Monto cobrado', { type: 'number', value: s.balance })}${field('account_code', 'Medio', { type: 'select', opts: moneyOptions('1102') })}</div>`,
      onSubmit: async (f, v) => {
        await setStatus(s.id, 'entregado');
        if (Number(v.amount) > 0) await post(`/api/sales/${s.id}/payments`, { date: today(), amount: v.amount, account_code: v.account_code });
        toast('Entregado y cobrado', 'ok'); reload();
      } });
  });
}
