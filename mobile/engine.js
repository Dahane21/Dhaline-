'use strict';
// Motor de la app para el navegador: la misma API de negocio, ejecutada sobre SQLite en memoria (sql.js).
const { Db } = require('../server/db-browser');
const SEED = require('../server/services/seed');
const { makeRouter, registerRoutes } = require('../server/routes');
const { nowIso } = require('../server/db-browser');

function createEngine(SQL, bytes) {
  let db, user, router;
  function open(b) {
    db = new Db(SQL, b);
    SEED.seedBase(db);
    let u = db.get("SELECT * FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
    if (!u) { db.insert('users', { username: 'yo', name: 'Yo', role: 'admin', pass_hash: 'local', created_at: nowIso() }); u = db.get("SELECT * FROM users WHERE username='yo'"); }
    user = { id: u.id, username: u.username, name: u.name, role: 'admin' };
    router = makeRouter();
    registerRoutes(router.route, db, { backup: null });
    const r = router.route;
    r('GET', '/api/auth/status', () => ({ needs_setup: false, user, local: true, app_name: db.setting('app_name'), company: db.setting('company_name') }));
    r('POST', '/api/auth/logout', () => ({ ok: true }));
    r('GET', '/api/users', () => []);
    r('GET', '/api/admin/backups', () => []);
  }
  open(bytes);

  async function request(method, url, body) {
    const u = new URL(url, 'http://local');
    const m = router.find(method, u.pathname);
    if (!m) return { status: 404, error: 'Ruta no encontrada.' };
    const ctx = { query: Object.fromEntries(u.searchParams), params: m.params, body: body ? JSON.parse(JSON.stringify(body)) : {}, user };
    try {
      const data = await m.handler(ctx);
      return { status: 200, data: data ?? { ok: true }, mutated: method !== 'GET' };
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return { status, error: status >= 500 ? 'Error interno. La operación no se registró (se revirtió por completo).' : e.message, detail: e.extra || null };
    }
  }
  return {
    request,
    exportBytes: () => db.export(),
    replace: (b) => { const old = db; open(b); try { old.close(); } catch { /* ya cerrada */ } },
    hasActivity: () => !!db.get('SELECT 1 FROM journal_entries LIMIT 1') || !!db.get('SELECT 1 FROM purchases LIMIT 1'),
  };
}

/** Comprueba que unos bytes sean una base de esta app (y la deja lista para abrir en memoria). */
function checkBytes(SQL, bytes) {
  const head = new TextDecoder().decode(bytes.slice(0, 15));
  if (head !== 'SQLite format 3') throw new Error('El archivo no es una base de datos de la app.');
  bytes[18] = 1; bytes[19] = 1; // modo WAL de la laptop → modo normal
  const t = new SQL.Database(bytes);
  try {
    const r = t.exec("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('items','sales','journal_entries')");
    if (!r.length || r[0].values[0][0] < 3) throw new Error('El archivo no tiene los datos de Chocolate Business Manager.');
  } finally { t.close(); }
  return bytes;
}

window.CBM_ENGINE = { createEngine, checkBytes };
