'use strict';
// Autenticación con sesiones (cookie HttpOnly) y contraseñas con scrypt. Roles: admin, operador, lectura.
const crypto = require('crypto');
const { bad, AppError } = require('./lib');
const { nowIso } = require('./db');
const { audit } = require('./services/audit');

const SESSION_DAYS = 30;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'hex');
  return exp.length === calc.length && crypto.timingSafeEqual(calc, exp);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function checkPassword(pw) { if (typeof pw !== 'string' || pw.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.'); return pw; }

function createUser(db, ctx, { username, name, role, password }) {
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username || '')) throw bad('Usuario: 3 a 30 caracteres (letras, números, punto, guion).');
  if (!['admin', 'operador', 'lectura'].includes(role)) throw bad('Rol inválido.');
  checkPassword(password);
  if (db.get('SELECT 1 FROM users WHERE username=?', username)) throw bad('Ese usuario ya existe.');
  const id = db.insert('users', { username, name: name || username, role, pass_hash: hashPassword(password), created_at: nowIso() });
  audit(db, ctx, 'crear', 'usuario', id, { username, role });
  return id;
}

function login(db, username, password) {
  const u = db.get('SELECT * FROM users WHERE username=? AND active=1', username || '');
  if (!u || !verifyPassword(password || '', u.pass_hash)) throw new AppError(401, 'Usuario o contraseña incorrectos.');
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)', sha(token), u.id, exp, nowIso());
  audit(db, { user: u }, 'login', 'usuario', u.id);
  return { token, user: publicUser(u) };
}
function logout(db, token) { if (token) db.run('DELETE FROM sessions WHERE token_hash=?', sha(token)); }
function userFromToken(db, token) {
  if (!token) return null;
  const r = db.get('SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.active=1', sha(token));
  if (!r || r.expires_at < nowIso()) return null;
  return publicUser(r);
}
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role }; }

// Limitador simple de intentos de login por IP
const attempts = new Map();
function rateLimit(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 10) throw new AppError(429, 'Demasiados intentos. Espere 15 minutos.');
  a.push(now); attempts.set(ip, a);
}

module.exports = { hashPassword, verifyPassword, createUser, login, logout, userFromToken, rateLimit, checkPassword };
