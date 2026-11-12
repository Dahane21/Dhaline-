'use strict';
// Utilidades comunes: errores, redondeo, validación, fechas.

class AppError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, extra) => new AppError(400, msg, extra);

const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const r4 = x => Math.round((Number(x) + Number.EPSILON) * 10000) / 10000;
const r6 = x => Math.round((Number(x) + Number.EPSILON) * 1e6) / 1e6;
const EPS = 1e-6;

function today() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)); }

// Validadores pequeños y explícitos
const V = {
  date(v, label = 'Fecha') { if (!isDate(v)) throw bad(`${label}: fecha inválida (use AAAA-MM-DD).`); return v; },
  num(v, label, { min = -Infinity, gt, int = false, optional = false } = {}) {
    if ((v === undefined || v === null || v === '') && optional) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw bad(`${label}: debe ser un número.`);
    if (gt !== undefined && !(n > gt)) throw bad(`${label}: debe ser mayor que ${gt}.`);
    if (n < min) throw bad(`${label}: debe ser mayor o igual a ${min}.`);
    if (int && !Number.isInteger(n)) throw bad(`${label}: debe ser un número entero.`);
    return n;
  },
  str(v, label, { optional = false, max = 300 } = {}) {
    if (v === undefined || v === null || String(v).trim() === '') {
      if (optional) return null; throw bad(`${label}: es obligatorio.`);
    }
    const s = String(v).trim(); if (s.length > max) throw bad(`${label}: demasiado largo.`); return s;
  },
  oneOf(v, label, list) { if (!list.includes(v)) throw bad(`${label}: valor no permitido (${list.join(', ')}).`); return v; },
  id(v, label) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad(`${label}: seleccione un valor.`); return n; },
  optId(v) { if (v === undefined || v === null || v === '' || v === 0 || v === '0') return null; const n = Number(v); if (!Number.isInteger(n)) throw bad('Identificador inválido.'); return n; },
  arr(v, label, { min = 1 } = {}) { if (!Array.isArray(v) || v.length < min) throw bad(`${label}: agregue al menos ${min} línea(s).`); return v; },
};

const UNITS = {
  g: { g: 1, kg: 1000 },
  ml: { ml: 1, l: 1000 },
  und: { und: 1, docena: 12, ciento: 100, millar: 1000 },
  m: { m: 1, cm: 0.01, rollo: null },
};
// Factor de conversión de la unidad de compra a la unidad base del insumo.
function unitFactor(item, unit) {
  if (unit === 'pres') {
    if (!item.pres_size) throw bad(`${item.name}: no tiene presentación definida (ej. "bolsa 250 g").`);
    return item.pres_size;
  }
  const f = (UNITS[item.base_unit] || {})[unit];
  if (!f) throw bad(`${item.name}: la unidad "${unit}" no es compatible con ${item.base_unit}.`);
  return f;
}

function monthOf(date) { return date.slice(0, 7); }
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

module.exports = { AppError, bad, r2, r4, r6, EPS, today, addDays, isDate, V, UNITS, unitFactor, monthOf, monthRange };
