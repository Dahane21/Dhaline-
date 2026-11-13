import { state, api, get, post, esc, field, toast, destroyCharts, $ } from './core.js';

const I = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  home: I('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'), bolt: I('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  cart: I('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2l2.5 11h11L21 7H6.5"/>'), box: I('<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>'),
  pot: I('<path d="M4 10h16v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM2 10h20M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2"/>'), star: I('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  gift: I('<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 12h18M12 8v13M12 8c-2-4-6-4-6-1s6 1 6 1 6 2 6-1-4-3-6 1"/>'), bag: I('<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>'),
  users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a3.5 3.5 0 0 1 0 7M18 15c2.5.5 4 2.5 4 6"/>'), wallet: I('<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>'),
  chart: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'), target: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  file: I('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'), bell: I('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  menu: I('<path d="M3 6h18M3 12h18M3 18h18"/>'),
};

const NAV = [
  ['Principal', [['dashboard', 'Dashboard', 'home'], ['rapido', 'Registro rápido', 'bolt'], ['alertas', 'Alertas', 'bell']]],
  ['Operación', [['compras', 'Compras', 'cart'], ['inventario', 'Inventario', 'box'], ['produccion', 'Producción', 'pot'], ['terminados', 'Productos terminados', 'star'], ['presentaciones', 'Presentaciones y cajas', 'gift'], ['ventas', 'Ventas y pedidos', 'bag'], ['clientes', 'Clientes', 'users']]],
  ['Finanzas', [['finanzas', 'Caja, gastos y socias', 'wallet'], ['rentabilidad', 'Rentabilidad', 'chart'], ['equilibrio', 'Punto de equilibrio', 'target'], ['reportes', 'Reportes', 'file']]],
  ['Sistema', [['configuracion', 'Configuración', 'gear']]],
];
const VIEWS = {
  dashboard: () => import('./views/dashboard.js'), rapido: () => import('./views/quick.js'), alertas: () => import('./views/alerts.js'),
  compras: () => import('./views/purchases.js'), inventario: () => import('./views/inventory.js'), produccion: () => import('./views/production.js'),
  terminados: () => import('./views/finished.js'), presentaciones: () => import('./views/presentations.js'), ventas: () => import('./views/sales.js'),
  clientes: () => import('./views/customers.js'), finanzas: () => import('./views/finance.js'), rentabilidad: () => import('./views/profitability.js'),
  equilibrio: () => import('./views/breakeven.js'), reportes: () => import('./views/reports.js'), configuracion: () => import('./views/settings.js'),
};

async function boot() {
  const st = await api('/api/auth/status');
  if (st.needs_setup) return renderAuth(true);
  if (!st.user) return renderAuth(false);
  state.user = st.user;
  state.meta = await get('/api/meta');
  renderShell();
  window.addEventListener('hashchange', route);
  route();
}

function renderAuth(setup) {
  const root = $('#root');
  root.innerHTML = `<div class="login"><form class="card" novalidate>
    <div class="brand-mark">D</div><h1>Chocolate Business Manager</h1>
    <p class="muted" style="text-align:center;margin:0 0 18px">${setup ? 'Configuración inicial: cree la cuenta administradora.' : 'Ingrese para continuar.'}</p>
    <div class="grid">${setup ? field('name', 'Nombre', { required: true }) : ''}${field('username', 'Usuario', { required: true, attrs: 'autocomplete="username"' })}
    ${field('password', 'Contraseña', { type: 'password', required: true, help: setup ? 'Mínimo 8 caracteres.' : '', attrs: `autocomplete="${setup ? 'new-password' : 'current-password'}"` })}
    <div class="note bad" data-err hidden></div><button class="btn primary" type="submit" style="justify-content:center">${setup ? 'Crear cuenta' : 'Ingresar'}</button></div></form></div>`;
  const form = root.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try { await post(setup ? '/api/auth/setup' : '/api/auth/login', v); boot(); }
    catch (err) { const el = form.querySelector('[data-err]'); el.hidden = false; el.textContent = err.message; }
  });
}

function renderShell() {
  const u = state.user;
  $('#root').innerHTML = `<div class="shell"><aside class="side" id="side">
      <div class="brand"><div class="brand-mark">D</div><div><b>${esc(state.meta.settings.company_name || 'Dhaline')}</b><span>Chocolate Business Manager</span></div></div>
      <nav class="nav">${NAV.map(([g, items]) => `<div class="nav-group">${esc(g)}</div>${items.map(([k, l, ic]) => `<a href="#/${k}" data-nav="${k}">${ICONS[ic]}<span>${esc(l)}</span>${k === 'alertas' ? '<span class="badge" id="alert-count" hidden></span>' : ''}</a>`).join('')}`).join('')}</nav>
      <div class="nav-group">Sesión</div><div class="small muted" style="padding:0 10px">${esc(u.name)} · ${esc(u.role)}</div>
      <div style="padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" id="theme">Tema</button>${window.CBM_LOCAL ? '' : '<button class="btn sm" id="logout">Salir</button>'}</div>
    </aside><main class="main"><div class="topbar"><button class="btn menu-btn" id="menu" aria-label="Menú">${ICONS.menu}</button><div class="spacer"></div><a class="btn primary" href="#/rapido">${ICONS.bolt} Registro rápido</a></div><div id="view"></div></main></div>`;
  if ($('#logout')) $('#logout').onclick = async () => { await post('/api/auth/logout'); location.hash = ''; location.reload(); };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  const saved = (() => { try { return localStorage.getItem('cbm-theme'); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next;
    try { localStorage.setItem('cbm-theme', next); } catch { /* sin almacenamiento */ }
    route();
  };
  refreshAlerts();
}
export async function refreshAlerts() {
  try { const a = await get('/api/alerts'); const el = $('#alert-count'); if (el) { el.hidden = !a.length; el.textContent = a.length; el.className = 'badge ' + (a.some(x => x.level === 'alta') ? 'bad' : 'warn'); } } catch { /* opcional */ }
}

async function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const key = VIEWS[name] ? name : 'dashboard';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === key));
  $('#side')?.classList.remove('open');
  destroyCharts();
  const view = $('#view'); view.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const mod = await VIEWS[key]();
    await mod.render(view, rest);
    const title = NAV.flatMap(g => g[1]).find(n => n[0] === key)?.[1];
    document.title = `${title} · Chocolate Business Manager`;
  } catch (e) { console.error(e); view.innerHTML = `<div class="note bad">No se pudo cargar la pantalla: ${esc(e.message)}</div>`; }
  refreshAlerts();
}
export const reload = () => route();
window.addEventListener('cbm:reload', route);
(window.CBM_LOCAL_READY || Promise.resolve()).then(boot).catch(e => { $('#root').innerHTML = `<div class="note bad" style="margin:20px">Error al iniciar: ${esc(e.message)}</div>`; toast(e.message, 'bad'); });
