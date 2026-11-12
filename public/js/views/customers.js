import { state, get, post, put, esc, money, table, badge, canWrite, modal, field, options, toast } from '../core.js';
import { reload } from '../forms.js';

export async function render(el) {
  const [rows, sales] = await Promise.all([get('/api/customers'), get('/api/sales?from=2000-01-01')]);
  const stats = id => { const s = sales.filter(x => x.customer_id === id && x.status !== 'cancelado'); return { n: s.length, total: s.reduce((a, x) => a + x.net_total, 0), balance: s.reduce((a, x) => a + x.balance, 0), last: s[0]?.date }; };
  const districts = (state.meta.settings.districts || '').split(',').filter(Boolean); const channels = (state.meta.settings.channels || '').split(',').filter(Boolean);
  el.innerHTML = `<div class="page-head"><div><h1>Clientes</h1><div class="sub">${rows.length} clientes · meta: clientes nuevos fuera de la familia.</div></div><div class="actions">${canWrite() ? '<button class="btn primary" id="new">+ Cliente</button>' : ''}</div></div>
  <div class="card"><div class="filters"><label class="f">Buscar<input id="q" placeholder="Nombre, distrito o canal"></label></div><div id="tbl"></div></div>`;
  const draw = (q = '') => el.querySelector('#tbl').innerHTML = table([
    { label: 'Cliente', render: r => `<b>${esc(r.name)}</b>${r.is_demo ? ' ' + badge('DEMO', 'demo') : ''}<div class="small muted">${esc(r.phone || '')}</div>` }, { label: 'Distrito', key: 'district' }, { label: 'Canal', key: 'channel' },
    { label: 'Pedidos', cls: 'n', render: r => stats(r.id).n }, { label: 'Comprado', cls: 'n', render: r => money(stats(r.id).total) }, { label: 'Saldo', cls: 'n', render: r => money(stats(r.id).balance) }, { label: 'Última compra', render: r => esc(stats(r.id).last || '—') },
    { label: '', render: r => canWrite() ? `<button class="btn sm" data-e="${r.id}">Editar</button>` : '' }],
    rows.filter(r => !q || `${r.name} ${r.district} ${r.channel}`.toLowerCase().includes(q.toLowerCase())), { empty: 'Aún no hay clientes.' });
  draw(); el.querySelector('#q').oninput = e => { draw(e.target.value); bind(); };
  const form = (c = {}) => modal({ title: c.id ? 'Editar cliente' : 'Nuevo cliente', body: `<div class="form-grid">${field('name', 'Nombre', { value: c.name, wide: true })}${field('phone', 'Teléfono / WhatsApp', { value: c.phone })}${field('district', 'Distrito', { type: 'select', opts: options([...districts, 'Otro'].map(d => ({ id: d, name: d })), { empty: '—', selected: c.district }) })}${field('channel', '¿Cómo nos conoció?', { type: 'select', opts: options(channels.map(d => ({ id: d, name: d })), { empty: '—', selected: c.channel }) })}${field('notes', 'Notas / opiniones', { type: 'textarea', wide: true, value: c.notes })}</div>`,
    onSubmit: async (f, v) => { c.id ? await put(`/api/customers/${c.id}`, v) : await post('/api/customers', v); toast('Cliente guardado', 'ok'); reload(); } });
  const bind = () => el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => form(rows.find(r => r.id === Number(b.dataset.e))));
  bind(); el.querySelector('#new')?.addEventListener('click', () => form());
}
