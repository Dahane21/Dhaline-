'use strict';
// Servidor HTTP (Node): autenticación, usuarios, respaldos en disco y archivos estáticos. Las rutas de negocio están en routes.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Db } = require('./db');
const { AppError, bad, V } = require('./lib');
const AUTH = require('./auth');
const SEED = require('./services/seed');
const { audit } = require('./services/audit');
const { makeRouter, registerRoutes, integrity } = require('./routes');
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function createApp({ dbFile, backupDir }) {
  const db = new Db(dbFile);
  SEED.seedBase(db);
  const { route, find, RANK } = makeRouter();
  const read = { role: 'lectura' }, admin = { role: 'admin' }, pub = { auth: false };
  const id = p => V.id(p.id, 'id');

  // ---------- Autenticación ----------
  route('GET', '/api/auth/status', (c) => ({ needs_setup: !db.get('SELECT 1 FROM users LIMIT 1'), user: c.user || null, app_name: db.setting('app_name'), company: db.setting('company_name') }), pub);
  route('POST', '/api/auth/setup', (c) => {
    if (db.get('SELECT 1 FROM users LIMIT 1')) throw new AppError(403, 'El sistema ya fue configurado.');
    db.tx(() => AUTH.createUser(db, {}, { ...c.body, role: 'admin' }));
    const r = AUTH.login(db, c.body.username, c.body.password); c.setCookie(r.token); return r.user;
  }, pub);
  route('POST', '/api/auth/login', (c) => { AUTH.rateLimit(c.ip); const r = AUTH.login(db, c.body.username, c.body.password); c.setCookie(r.token); return r.user; }, pub);
  route('POST', '/api/auth/logout', (c) => { AUTH.logout(db, c.token); c.setCookie('', true); return { ok: true }; }, read);
  route('POST', '/api/auth/password', (c) => {
    const u = db.get('SELECT * FROM users WHERE id=?', c.user.id);
    if (!AUTH.verifyPassword(c.body.current || '', u.pass_hash)) throw bad('La contraseña actual no es correcta.');
    AUTH.checkPassword(c.body.password); db.run('UPDATE users SET pass_hash=? WHERE id=?', AUTH.hashPassword(c.body.password), u.id);
    audit(db, c, 'cambiar_clave', 'usuario', u.id); return { ok: true };
  }, read);

  route('GET', '/api/users', () => db.all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id'), admin);
  route('POST', '/api/users', (c) => db.tx(() => ({ id: AUTH.createUser(db, c, c.body) })), admin);
  route('PUT', '/api/users/:id', (c) => db.tx(() => {
    const uid = id(c.params); const o = { name: V.str(c.body.name, 'Nombre'), role: V.oneOf(c.body.role, 'Rol', ['admin', 'operador', 'lectura']), active: c.body.active ? 1 : 0 };
    if (uid === c.user.id && (o.role !== 'admin' || !o.active)) throw bad('No puede quitarse a sí misma el rol de administradora.');
    db.update('users', uid, o);
    if (c.body.password) db.run('UPDATE users SET pass_hash=? WHERE id=?', AUTH.hashPassword(AUTH.checkPassword(c.body.password)), uid);
    if (!o.active) db.run('DELETE FROM sessions WHERE user_id=?', uid);
    audit(db, c, 'editar', 'usuario', uid, { ...o, password_changed: !!c.body.password }); return { ok: true };
  }), admin);
  route('GET', '/api/admin/backup', (c) => {
    const file = backup(db, backupDir, 'manual'); audit(db, c, 'respaldo', 'sistema', null, { file: path.basename(file) });
    return { __raw: fs.readFileSync(file), type: 'application/vnd.sqlite3', filename: path.basename(file) };
  }, admin);
  route('GET', '/api/admin/backups', () => fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().reverse() : [], admin);

  registerRoutes(route, db, { backup: tag => path.basename(backup(db, backupDir, tag)) });

  // ---------- Servidor ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const headers = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'" };
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res, headers);
    const ctx = { query: Object.fromEntries(url.searchParams), params: {}, ip: req.socket.remoteAddress, token: cookies.cbm_session, cookie: null };
    ctx.setCookie = (tok, clear) => { ctx.cookie = `cbm_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 30 * 86400}${secure ? '; Secure' : ''}`; };
    try {
      const m = find(req.method, url.pathname);
      if (!m) throw new AppError(404, 'Ruta no encontrada.');
      ctx.params = m.params;
      ctx.user = AUTH.userFromToken(db, ctx.token);
      if (m.auth) {
        if (!ctx.user) throw new AppError(401, 'Sesión no iniciada o vencida.');
        if (RANK[ctx.user.role] < RANK[m.role]) throw new AppError(403, 'Su usuario no tiene permiso para esta acción.');
      }
      if (req.method !== 'GET') {
        // Protección CSRF: solo peticiones JSON del mismo origen
        if (!(req.headers['content-type'] || '').includes('application/json')) throw new AppError(415, 'Se requiere JSON.');
        const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw new AppError(403, 'Origen no permitido.');
        ctx.body = await readBody(req);
      } else ctx.body = {};
      const out = await m.handler(ctx);
      if (ctx.cookie) headers['Set-Cookie'] = ctx.cookie;
      if (out && out.__raw) {
        headers['Content-Type'] = out.type; if (out.filename) headers['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        res.writeHead(200, headers); return res.end(out.__raw);
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status >= 500 ? 'Error interno. La operación no se registró (se revirtió por completo).' : e.message, detail: e.extra || null }));
    }
  }
  const server = http.createServer((q, s) => { handle(q, s).catch(e => { console.error(e); try { s.writeHead(500); s.end(); } catch {} }); });
  return { server, db };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new AppError(413, 'Solicitud demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch { reject(bad('JSON inválido.')); } });
    req.on('error', reject);
  });
}
function serveStatic(p, res, headers) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}
function backup(db, dir, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `cbm-${tag}-${stamp}.db`);
  db.backupTo(file);
  // Conserva los 20 respaldos más recientes
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  while (files.length > 20) fs.unlinkSync(path.join(dir, files.shift()));
  return file;
}
module.exports = { createApp, integrity };
