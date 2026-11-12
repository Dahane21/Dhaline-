// Utilidades de interfaz: API, formato, tablas, formularios, modales y editores de líneas.
export const state = { meta: null, user: null, cache: {} };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth')) { location.hash = ''; location.reload(); }
    const err = new Error((data && data.error) || `Error ${res.status}`); err.detail = data && data.detail; throw err;
  }
  return data;
}
export const get = p => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf2 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const money = v => (v === null || v === undefined || v === '' ? '—' : `S/ ${nf2.format(Math.abs(Number(v)) < 0.005 ? 0 : Number(v))}`);
export const money4 = v => (v === null || v === undefined ? '—' : `S/ ${nf4.format(Number(v))}`);
export const qty = (v, d = 2) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('es-PE', { maximumFractionDigits: d }));
export const pct = v => (v === null || v === undefined || !isFinite(v) ? '—' : `${(v * 100).toLocaleString('es-PE', { maximumFractionDigits: 1 })}%`);
export const today = () => state.meta?.today || new Date().toISOString().slice(0, 10);
export const monthStart = () => today().slice(0, 8) + '01';
export const canWrite = () => state.user && state.user.role !== 'lectura';
export const isAdmin = () => state.user && state.user.role === 'admin';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const LABEL = {
  materia_prima: 'Materia prima', empaque: 'Empaque', suministro: 'Suministro', pendiente: 'Pendiente', preparacion: 'En preparación', listo: 'Listo', entregado: 'Entregado', cancelado: 'Cancelado',
  operativo: 'Operativo', administrativo: 'Administrativo', marketing: 'Marketing', delivery: 'Delivery', comisiones: 'Comisiones de pago', otros: 'Otros egresos', mano_obra: 'Mano de obra', financiero: 'Financiero',
  inventario: 'Inventario', activo: 'Herramienta / activo', gasto: 'Gasto directo', pagado: 'Pagado', credito: 'Al crédito', parcial: 'Parcial', 'saldo a favor': 'Saldo a favor',
};
export const label = k => LABEL[k] || k;
export const moneyName = code => state.meta?.money?.[code] || code || '—';

export function badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; }
export function statusBadge(s) {
  const STATUS = { activo: 'Activo', activa: 'Activa', anulado: 'Anulado', anulada: 'Anulada', baja: 'Dado de baja' };
  const k = { entregado: 'ok', listo: 'brand', preparacion: 'warn', pendiente: '', cancelado: 'bad', pagado: 'ok', parcial: 'warn', anulado: 'bad', anulada: 'bad', activo: 'ok', activa: 'ok', credito: 'warn', 'saldo a favor': 'brand' }[s] ?? '';
  return badge(STATUS[s] || label(s), k);
}

/** Tabla: columns = [{label, key?, render?(row), cls?, foot?}] */
export function table(columns, rows, { empty = 'Sin registros todavía.', rowAttr, foot } = {}) {
  if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="t"><thead><tr>${columns.map(c => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
  ${rows.map((r, i) => `<tr ${rowAttr ? rowAttr(r, i) : ''}>${columns.map(c => `<td class="${c.cls || ''}">${c.render ? c.render(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}
  </tbody>${foot ? `<tfoot><tr>${columns.map((c, i) => `<td class="${c.cls || ''}">${foot[i] ?? ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}

export function options(list, { value = 'id', text = 'name', selected, empty } = {}) {
  const sel = selected === undefined || selected === null ? '' : String(selected);
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + list.map(o => {
    const v = typeof value === 'function' ? value(o) : o[value]; const t = typeof text === 'function' ? text(o) : o[text];
    return `<option value="${esc(v)}" ${String(v) === sel ? 'selected' : ''}>${esc(t)}</option>`;
  }).join('');
}
export const moneyOptions = (selected = '1101') => options(Object.entries(state.meta.money).map(([id, name]) => ({ id, name })), { selected });
export const catOptions = (selected) => options(state.meta.expense_categories.map(c => ({ id: c, name: label(c) })), { selected });

/** Campo de formulario. type: text|number|date|select|textarea|checkbox */
export function field(name, lbl, { type = 'text', value = '', opts = '', help = '', step = 'any', min, required, wide, attrs = '' } = {}) {
  const req = required ? 'required' : '';
  let input;
  if (type === 'select') input = `<select name="${name}" ${req} ${attrs}>${opts}</select>`;
  else if (type === 'textarea') input = `<textarea name="${name}" ${attrs}>${esc(value)}</textarea>`;
  else if (type === 'checkbox') return `<label class="check ${wide ? 'wide' : ''}"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${attrs}> ${esc(lbl)}</label>`;
  else input = `<input name="${name}" type="${type}" value="${esc(value)}" ${type === 'number' ? `step="${step}"` : ''} ${min !== undefined ? `min="${min}"` : ''} ${req} ${attrs}>`;
  return `<label class="f ${wide ? 'wide' : ''}">${esc(lbl)}${input}${help ? `<span class="help">${esc(help)}</span>` : ''}</label>`;
}
export function readForm(form) {
  const o = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.closest('[data-lines]')) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else o[el.name] = el.value;
  }
  return o;
}

/**
 * Editor de líneas dinámico. columns: [{key, label, type:'select'|'number'|'text', options:(row)=>html, width, calc:(row)=>html}]
 */
export function linesEditor(host, { columns, rows = [], blank = () => ({}), onChange = () => {}, addLabel = 'Agregar línea', min = 1 }) {
  host.setAttribute('data-lines', '');
  let data = rows.length ? rows.map(r => ({ ...r })) : Array.from({ length: min }, blank);
  const render = () => {
    host.innerHTML = `<div class="table-wrap"><table class="lines"><thead><tr>${columns.map(c => `<th style="${c.width ? `width:${c.width}` : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${data.map((r, i) => `<tr data-i="${i}">${columns.map(c => {
        if (c.calc) return `<td class="calc">${c.calc(r)}</td>`;
        const v = r[c.key] ?? '';
        if (c.type === 'select') return `<td><select data-k="${c.key}">${c.options(r)}</select></td>`;
        return `<td><input data-k="${c.key}" type="${c.type || 'text'}" ${c.type === 'number' ? 'step="any"' : ''} value="${esc(v)}" placeholder="${esc(c.placeholder || '')}"></td>`;
      }).join('')}<td><button type="button" class="btn ghost sm" data-del="${i}" title="Quitar">✕</button></td></tr>`).join('')}
    </tbody></table></div><button type="button" class="btn sm" data-add>+ ${esc(addLabel)}</button>`;
  };
  render();
  host.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr || !e.target.dataset.k) return;
    const r = data[tr.dataset.i]; const c = columns.find(x => x.key === e.target.dataset.k);
    r[e.target.dataset.k] = e.target.value;
    if (c && c.onSet) c.onSet(r, e.target.value);
    if (e.type === 'input' && e.target.tagName === 'SELECT') return;
    tr.querySelectorAll('td.calc').forEach((td) => { const cc = columns.filter(x => x.calc)[[...tr.querySelectorAll('td.calc')].indexOf(td)]; td.innerHTML = cc.calc(r); });
    onChange(data);
  });
  host.addEventListener('change', e => {
    if (e.target.tagName !== 'SELECT') return;
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const r = data[tr.dataset.i]; r[e.target.dataset.k] = e.target.value;
    const c = columns.find(x => x.key === e.target.dataset.k); if (c && c.onSet) c.onSet(r, e.target.value);
    render(); onChange(data);
  });
  host.addEventListener('click', e => {
    if (e.target.closest('[data-add]')) { data.push(blank()); render(); onChange(data); }
    const d = e.target.closest('[data-del]'); if (d) { data.splice(Number(d.dataset.del), 1); if (data.length < min) data.push(blank()); render(); onChange(data); }
  });
  return { get: () => data, set: rs => { data = rs.map(r => ({ ...r })); if (!data.length) data.push(blank()); render(); onChange(data); }, render };
}

// ---------- Modales y avisos ----------
export function modal({ title, body = '', wide = false, submit = 'Guardar', onSubmit, onOpen, extraFoot = '', cancel = 'Cancelar' }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal ${wide ? 'wide' : ''}" novalidate><div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost x" data-close aria-label="Cerrar">✕</button></div>
    <div class="modal-body">${body}<div class="note bad" data-err hidden></div></div>
    <div class="modal-foot">${extraFoot}${cancel ? `<button type="button" class="btn" data-close>${esc(cancel)}</button>` : ''}${onSubmit ? `<button class="btn primary" type="submit">${esc(submit)}</button>` : ''}</div></form>`;
  document.body.appendChild(bg);
  const form = bg.querySelector('form');
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  const showError = (msg) => { const el = form.querySelector('[data-err]'); el.hidden = !msg; el.textContent = msg || ''; if (msg) el.scrollIntoView({ block: 'nearest' }); };
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!onSubmit) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true; showError('');
    try { const r = await onSubmit(form, readForm(form)); if (r !== false) close(); }
    catch (err) { showError(err.message); }
    finally { btn.disabled = false; }
  });
  const ctl = { root: form, close, showError };
  if (onOpen) onOpen(form, ctl);
  setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30);
  return ctl;
}
export function toast(msg, kind = '') {
  let host = document.querySelector('.toasts'); if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.appendChild(host); }
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; host.appendChild(t); setTimeout(() => t.remove(), 4200);
}
/** Pide motivo (anulaciones/cancelaciones auditables). */
export function askReason(title, help = 'La operación no se borra: se registra una anulación con contrapartida y queda en la auditoría.') {
  return new Promise(resolve => {
    modal({ title, submit: 'Confirmar', body: `<p class="muted small">${esc(help)}</p>${field('reason', 'Motivo', { required: true })}`,
      onSubmit: (f, v) => { if (!v.reason.trim()) throw new Error('Indique el motivo.'); resolve(v.reason.trim()); } });
  });
}
export async function run(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'bad'); throw e; } }

// ---------- Gráficos (Chart.js) ----------
export function palette() {
  const s = getComputedStyle(document.documentElement);
  return { series: ['--c1', '--c2', '--c3', '--c4', '--c5'].map(v => s.getPropertyValue(v).trim()), ink: s.getPropertyValue('--ink-2').trim(), muted: s.getPropertyValue('--muted').trim(), grid: s.getPropertyValue('--grid').trim(), surface: s.getPropertyValue('--surface').trim() };
}
const charts = new Set();
export function destroyCharts() { charts.forEach(c => c.destroy()); charts.clear(); }
export function chart(canvas, cfg) {
  if (!window.Chart || !canvas) return null;
  const p = palette();
  window.Chart.defaults.color = p.muted; window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const base = {
    responsive: true, maintainAspectRatio: false, interaction: { mode: cfg.type === 'line' ? 'index' : 'nearest', intersect: cfg.type !== 'line' },
    plugins: { legend: { display: cfg.legend ?? false, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
      tooltip: { callbacks: { label: ctx => `${ctx.dataset.label || ctx.label}: ${cfg.fmt ? cfg.fmt(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed) : ctx.formattedValue}` } } },
  };
  if (cfg.type === 'bar' || cfg.type === 'line') base.scales = {
    x: { grid: { display: false }, border: { color: p.grid }, ticks: { color: p.muted }, ...(cfg.indexAxis === 'y' ? { grid: { color: p.grid }, ticks: { callback: v => cfg.fmt ? cfg.fmt(v) : v } } : {}) },
    y: { grid: { color: cfg.indexAxis === 'y' ? 'transparent' : p.grid }, border: { display: false }, ticks: { color: p.muted, callback: function (v) { return cfg.indexAxis === 'y' ? this.getLabelForValue(v) : (cfg.fmt ? cfg.fmt(v) : v); } }, beginAtZero: true },
  };
  const c = new window.Chart(canvas, { type: cfg.type, data: cfg.data, options: Object.assign(base, { indexAxis: cfg.indexAxis || 'x' }, cfg.options || {}) });
  charts.add(c); return c;
}
export const shortMoney = v => `S/ ${Number(v).toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
