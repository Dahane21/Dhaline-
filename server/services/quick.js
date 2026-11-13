'use strict';
/**
 * Registro rápido: convierte texto en español a un BORRADOR de operación estructurada.
 * Reglas locales (sin IA). Nunca registra: devuelve borrador + preguntas para lo que falte.
 * Nunca inventa precios, cantidades ni consumos: lo que no está en el texto queda como pregunta.
 * Arquitectura: parse(db, text) es la interfaz; un adaptador externo (opcional) podría implementar la misma firma.
 */
const { today, addDays, r2, r6 } = require('../lib');

const NUM_WORDS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100, media: 0.5, medio: 0.5 };
const UNIT_WORDS = [
  [/^(kg|kgs|kilo|kilos|kilogramo|kilogramos)$/, 'kg'], [/^(g|gr|grs|gramo|gramos)$/, 'g'],
  [/^(l|lt|lts|litro|litros)$/, 'l'], [/^(ml|mililitro|mililitros)$/, 'ml'],
  [/^(m|mt|mts|metro|metros)$/, 'm'], [/^(cm|centimetro|centimetros)$/, 'cm'],
  [/^(und|unds|unidad|unidades|u)$/, 'und'], [/^(docena|docenas)$/, 'docena'], [/^(ciento|cientos)$/, 'ciento'],
  [/^(bolsa|bolsas|paquete|paquetes|sobre|sobres|presentacion|presentaciones)$/, 'pres'],
];

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim(); }
function singular(w) { if (w.length > 4 && w.endsWith('es') && !w.endsWith('ces')) return w.slice(0, -2); if (w.endsWith('ces')) return w.slice(0, -3) + 'z'; if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1); return w; }
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'para', 'con', 'y', 'a', 'en', 'por', 'un', 'una', 'mi', 'el', 'emprendimiento']);
function tokens(s) { return norm(s).split(/[^a-z0-9\u00f1]+/).filter(t => t && !STOP.has(t)).map(singular); }

function parseNumber(t) {
  if (t === undefined) return null;
  const x = norm(t);
  if (NUM_WORDS[x] !== undefined) return NUM_WORDS[x];
  const m = x.replace(',', '.').match(/^\d+(\.\d+)?$/);
  return m ? Number(m[0]) : null;
}
function unitOf(w) { const x = norm(w); for (const [re, u] of UNIT_WORDS) if (re.test(x)) return u; return null; }

function parseDate(text) {
  const t = norm(text);
  if (/\banteayer\b/.test(t)) return { date: addDays(today(), -2), explicit: true };
  if (/\bayer\b/.test(t)) return { date: addDays(today(), -1), explicit: true };
  const m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? Number(m[3]) : Number(today().slice(0, 4)); if (y < 100) y += 2000;
    const d = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!isNaN(Date.parse(d))) return { date: d, explicit: true };
  }
  return { date: today(), explicit: /\bhoy\b/.test(t) };
}

/** Busca el mejor insumo/producto/presentación por coincidencia de palabras (nombre + alias). */
function bestMatch(list, phrase, nameKey = 'name') {
  const pt = tokens(phrase); if (!pt.length) return null;
  let best = null;
  for (const it of list) {
    const names = [it[nameKey], ...(it.aliases ? String(it.aliases).split(',') : [])];
    for (const n of names) {
      const nt = tokens(n); if (!nt.length) continue;
      const hit = pt.filter(t => nt.some(x => x === t || (x.length > 4 && t.length > 4 && (x.startsWith(t) || t.startsWith(x))))).length;
      if (!hit) continue;
      const score = hit / Math.max(nt.length, 1) + hit / pt.length;
      if (!best || score > best.score) best = { item: it, score };
    }
  }
  return best && best.score >= 0.8 ? best.item : null;
}

// Extrae un importe "S/ 32", "s/.32", "32 soles"
const MONEY_RE = /(?:s\/\.?\s*|soles?\s*)(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*soles?/;
function money(s) { const m = norm(s).match(MONEY_RE); if (!m) return null; return Number((m[1] || m[2]).replace(',', '.')); }

/** Divide en cláusulas por comas y " y " (respetando decimales). */
function clauses(text) {
  return norm(text).replace(/(\d),(\d)/g, '$1.$2').split(/,|;|\s+y\s+(?=(?:\d|un\b|una\b|dos\b|tres\b|cuatro\b|cinco\b|seis\b|diez\b|veinte\b|media\b|medio\b|compre|use|utilice|vendi|gaste|pague))/).map(s => s.trim()).filter(Boolean);
}

/** "2 kg de cobertura a s/ 32" → { qty, unit, name, price, priceMode } */
function parseQtyPhrase(c) {
  let s = c.replace(/^(hoy|ayer|anteayer)\s+/, '').replace(/^(compre|use|utilice|ocupe|gaste|vendi|consumi|emple\u00e9|emplee)\s+/, '').replace(/\b(hoy|ayer)\b/g, '').trim();
  let price = null, priceMode = null;
  const pm = s.match(/\s(a|por|en)\s+(s\/\.?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*soles?)(\s+(c\/u|cada\s+un[oa]|la\s+unidad|el\s+(kg|kilo|metro)|por\s+(kg|kilo|unidad|metro)))?/);
  if (pm) {
    price = money(pm[2]);
    priceMode = pm[3] ? 'unit' : pm[1] === 'por' || pm[1] === 'en' ? 'total' : 'ambiguous';
    s = s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm[0].length);
  } else {
    const pm2 = s.match(/(s\/\.?\s*\d+(?:\.\d+)?)/); if (pm2) { price = money(pm2[1]); priceMode = 'total'; s = s.replace(pm2[1], ' '); }
  }
  const words = s.trim().split(/\s+/);
  let qty = null, unit = null, i = 0;
  const n0 = parseNumber(words[0]);
  if (n0 !== null) {
    qty = n0; i = 1;
    if (words[1] === 'y' && words[2] === 'medio') { qty += 0.5; i = 3; }
    const u = unitOf(words[i] || ''); if (u) { unit = u; i++; }
  } else {
    const u = unitOf(words[0] || ''); if (u) { qty = 1; unit = u; i = 1; } // "kilo de manjar"
  }
  if (words[i] === 'de') i++;
  const rest = words.slice(i).join(' ').replace(/\s+(para|que|en)\s+.*$/, '').trim();
  return { qty, unit, name: rest, price, priceMode, raw: c };
}

function detectType(t) {
  if (/\b(vendi|venta|vendimos|cobre)\b/.test(t)) return 'venta';
  if (/\b(para\s+producir|produje|producimos|elabore|prepare|hice)\b/.test(t)) return 'produccion';
  if (/\b(aporte|aporto|aportamos|puse\s+capital)\b/.test(t)) return 'aporte';
  if (/\b(compre|compramos|adquiri)\b/.test(t)) return 'compra';
  if (/\b(pague|gaste|gastamos)\b/.test(t)) return 'gasto';
  if (/\b(use|utilice|ocupe|consumi)\b/.test(t)) return 'consumo';
  return null;
}
function detectAccount(t) {
  if (/\byape\b/.test(t)) return '1102'; if (/\bplin\b/.test(t)) return '1103';
  if (/\b(transferencia|banco|deposito)\b/.test(t)) return '1104'; if (/\b(efectivo|cash)\b/.test(t)) return '1101';
  return null;
}
const ASSET_WORDS = /\b(utensilio|herramienta|molde|batidora|balanza|olla|espatula|termometro|equipo|refrigeradora|cocina|horno)/;

function parse(db, text) {
  const t = norm(text);
  const out = { input: text, type: detectType(t), date: null, questions: [], warnings: [], draft: null };
  const { date, explicit } = parseDate(text);
  out.date = date;
  if (!explicit) out.warnings.push(`No se indicó la fecha; se propone hoy (${date}).`);
  if (!out.type) { out.questions.push({ field: 'type', q: '¿Qué tipo de operación es? (compra, producción, venta, gasto, consumo)' }); return out; }
  const items = db.all('SELECT id, name, aliases, base_unit, type, pres_size, pres_label, last_cost FROM items WHERE active=1');
  const products = db.all('SELECT id, name, aliases FROM products WHERE active=1');
  const presentations = db.all('SELECT id, name, aliases, price FROM presentations WHERE active=1');
  const quals = db.all('SELECT * FROM quality_categories ORDER BY sort');
  const account = detectAccount(t);

  if (out.type === 'compra' || out.type === 'consumo') {
    // "compré X ... y utilicé Y para ..." mezcla compra con consumo
    const parts = t.split(/\s+y\s+(?=(?:use|utilice|ocupe|consumi)\b)/);
    const buyText = out.type === 'compra' ? parts[0] : null;
    const useText = out.type === 'consumo' ? parts[0] : parts[1];
    if (buyText) {
      const lines = [];
      for (const c of clauses(buyText)) {
        const p = parseQtyPhrase(c);
        if (!p.name && p.price === null) continue;
        const isAsset = ASSET_WORDS.test(p.name);
        const it = isAsset ? null : bestMatch(items, p.name);
        const line = { kind: isAsset ? 'activo' : 'inventario', item_id: it?.id || null, item_name: it?.name || null, description: cap(p.name), qty: p.qty, unit: null, unit_price: null, total: null, new_item: null, notes: [] };
        if (it) {
          line.unit = p.unit ? mapUnit(it, p.unit) : (it.base_unit === 'und' ? 'und' : null);
          if (p.unit && !line.unit) line.notes.push(`La unidad "${p.unit}" no es compatible con ${it.name} (${it.base_unit}).`);
        } else if (!isAsset) {
          line.new_item = { name: cap(singularPhrase(p.name)), type: guessType(p.name), base_unit: guessBase(p.unit, p.name) };
          line.unit = p.unit || line.new_item.base_unit;
          out.questions.push({ field: 'item', q: `"${p.name}" no existe en el catálogo. ¿Crear el insumo "${line.new_item.name}" (${line.new_item.type.replace('_', ' ')}, unidad ${line.new_item.base_unit}) o elegir uno existente?` });
        } else line.unit = 'und';
        if (isAsset && p.qty === null) line.qty = 1;
        if (line.qty === null) out.questions.push({ field: 'qty', q: `¿Qué cantidad de ${p.name || 'producto'} compraste${line.unit ? ' (en ' + line.unit + ')' : ''}?` });
        if (p.price === null) out.questions.push({ field: 'price', q: `¿Cuánto pagaste por ${p.name}?` });
        else if (p.priceMode === 'unit') line.unit_price = p.price;
        else if (p.priceMode === 'total' || line.qty === 1 || line.qty === null) line.total = p.price;
        else {
          // Ambiguo ("2 kg a S/ 32"): se usa el precio de referencia para proponer la interpretación más probable
          const f = it && line.unit ? factorFor(it, line.unit) : null;
          const ref = it && f ? it.last_cost * f : null;
          if (ref && Math.abs(p.price - ref) < Math.abs(p.price - ref * line.qty)) { line.unit_price = p.price; out.warnings.push(`Interpreté S/ ${p.price} como precio por ${line.unit} de ${it.name} (referencia S/ ${r2(ref)}). Corrija si es el total.`); }
          else { line.total = p.price; out.warnings.push(`Interpreté S/ ${p.price} como importe total de ${p.name}. Corrija si es precio por unidad.`); }
        }
        lines.push(line);
      }
      out.draft = { kind: 'compra', date, account_code: account, pay_status: 'pagado', lines };
      if (!account) out.questions.push({ field: 'account_code', q: '¿Con qué medio pagaste? (efectivo, Yape, Plin, transferencia) o ¿fue al crédito?' });
    }
    if (useText) {
      const cons = [];
      for (const c of clauses(useText)) {
        const p = parseQtyPhrase(c);
        let it = bestMatch(items, p.name);
        if (!it && out.draft?.lines?.length === 1) { const l = out.draft.lines[0]; if (l.item_id) it = items.find(x => x.id === l.item_id); }
        const purpose = (useText.match(/para\s+(.*)$/) || [])[1] || '';
        cons.push({ item_id: it?.id || null, item_name: it?.name || (out.draft?.lines?.[0]?.new_item?.name ?? null), qty: p.qty, unit: p.unit, base_qty: it && p.qty !== null && p.unit ? toBase(it, p.qty, p.unit) : (it && p.qty !== null && !p.unit ? p.qty : null), purpose });
        if (p.qty === null) out.questions.push({ field: 'consumo', q: `¿Qué cantidad de ${p.name} utilizaste?` });
      }
      const dest = /\b(caja|cajas|presentacion|regalo|navide)/.test(useText) ? 'armado' : null;
      out.consumption = { date, lines: cons, destination: dest };
      out.questions.push(dest === 'armado'
        ? { field: 'destino', q: 'El consumo es para decorar cajas: ¿lo asigno a un armado de presentaciones (elige presentación y cantidad) o lo registro como consumo directo del periodo?' }
        : { field: 'destino', q: '¿El consumo se asigna a un lote de producción, a un armado de cajas, o es consumo directo (gasto/merma)?' });
      if (!out.draft) out.draft = { kind: 'consumo', date, lines: cons };
    }
    if (out.draft?.kind === 'compra' && out.draft.lines.every(l => l.kind === 'activo')) out.warnings.push('Se registrará como herramienta/activo (no es costo de producción ni gasto del mes).');
    return out;
  }

  if (out.type === 'produccion') {
    const [usePart, prodPart] = t.split(/\s+para\s+(?:producir|hacer|elaborar|preparar)\s+/);
    const cons = [];
    for (const c of clauses(usePart || '')) {
      const p = parseQtyPhrase(c); if (!p.name) continue;
      const it = bestMatch(items, p.name);
      const line = { item_id: it?.id || null, item_name: it?.name || null, phrase: p.raw, qty_input: p.qty, unit: p.unit, qty: null };
      if (!it) out.questions.push({ field: 'item', q: `No encontré "${p.name}" en el inventario. ¿Qué insumo es?` });
      else if (p.qty === null) out.questions.push({ field: 'qty', q: `¿Cuánto ${it.name} utilizaste?` });
      else if (!p.unit && it.base_unit !== 'und') out.questions.push({ field: 'unit', q: `Indicaste ${p.qty} de ${it.name}, pero se controla en ${it.base_unit}. ¿Cuántos ${it.base_unit} son ${p.qty} unidades?` });
      else if (p.unit && !mapUnit(it, p.unit)) out.questions.push({ field: 'unit', q: `"${p.unit}" no es compatible con ${it.name} (${it.base_unit}). ¿Cuántos ${it.base_unit} usaste?` });
      else line.qty = p.unit ? toBase(it, p.qty, p.unit) : p.qty;
      cons.push(line);
    }
    let qty = null, product = null;
    if (prodPart) {
      const p = parseQtyPhrase(prodPart); qty = p.qty;
      product = bestMatch(products, prodPart);
      if (!product) {
        // Intenta deducir el sabor por el ingrediente distintivo usado
        for (const l of cons) { const pr = l.item_name && bestMatch(products, l.item_name); if (pr) { product = pr; out.warnings.push(`Propuse "${pr.name}" porque usaste ${l.item_name}. Confirme el producto.`); break; } }
      }
    }
    if (!qty) out.questions.push({ field: 'qty_produced', q: '¿Cuántas unidades produjiste?' });
    if (!product) out.questions.push({ field: 'product', q: '¿Qué producto elaboraste?' });
    out.questions.push({ field: 'outputs', q: `De las ${qty || '?'} unidades, ¿cuántas quedaron originales, de segunda y no comercializables?` });
    out.draft = { kind: 'produccion', date, product_id: product?.id || null, product_name: product?.name || null, qty_produced: qty, consumptions: cons, outputs: null };
    return out;
  }

  if (out.type === 'venta') {
    const body = t.replace(/^.*?\b(vendi|vendimos)\b/, '');
    const lines = [];
    for (const c of clauses(body)) {
      const p = parseQtyPhrase(c); if (p.qty === null) continue;
      const q = /\b(defectuos|segunda|imperfect|fea|feas)/.test(c) ? quals.find(x => x.code === 'B') : /\b(original|premium|perfect)/.test(c) ? quals.find(x => x.code === 'A') : null;
      const pres = bestMatch(presentations, p.name);
      const prod = pres ? null : bestMatch(products, p.name.replace(/\b(originales?|defectuosas?|de segunda|premium)\b/g, ''));
      let unit_price = null;
      if (p.price !== null) unit_price = p.priceMode === 'total' && p.qty ? r2(p.price / p.qty) : p.price;
      const line = pres ? { kind: 'presentacion', presentation_id: pres.id, name: pres.name, qty: p.qty, unit_price } : { kind: 'producto', product_id: prod?.id || null, name: prod?.name || null, quality_id: q?.id || null, quality: q?.name || null, qty: p.qty, unit_price };
      if (!pres && !prod) out.questions.push({ field: 'product', q: `¿Qué producto vendiste en "${p.raw}"? (sabor o presentación)` });
      if (!pres && !q) out.questions.push({ field: 'quality', q: `¿Las ${p.qty} unidades de "${p.raw}" son originales o de segunda?` });
      if (unit_price === null) out.questions.push({ field: 'price', q: `¿A qué precio vendiste "${p.raw}"?` });
      lines.push(line);
    }
    // Si una línea no tiene producto pero otra sí, se sugiere el mismo
    const known = lines.find(l => l.kind === 'producto' && l.product_id);
    out.draft = { kind: 'venta', date, status: 'entregado', lines, payment: account ? { account_code: account } : null, product_hint: known ? { id: known.product_id, name: known.name } : null };
    out.questions.push({ field: 'payment', q: account ? 'Confirme si ya cobró el total.' : '¿Ya te pagaron? ¿Por qué medio (efectivo, Yape, Plin)?' });
    return out;
  }

  if (out.type === 'gasto') {
    const amt = money(t);
    const cat = /\b(publicidad|anuncio|instagram|tiktok|marketing|volante)/.test(t) ? 'marketing' : /\b(delivery|envio|movilidad|taxi)/.test(t) ? 'delivery' : /\b(comision)/.test(t) ? 'comisiones' : null;
    out.draft = { kind: 'gasto', date, amount: amt, category: cat, description: cap(text.replace(/^(hoy|ayer)\s+/i, '')), account_code: account };
    if (amt === null) out.questions.push({ field: 'amount', q: '¿Cuál fue el monto?' });
    if (!cat) out.questions.push({ field: 'category', q: '¿Qué tipo de gasto es? (operativo, administrativo, marketing, delivery, otros)' });
    if (!account) out.questions.push({ field: 'account_code', q: '¿Con qué medio pagaste?' });
    return out;
  }

  if (out.type === 'aporte') {
    const amt = money(t);
    out.draft = { kind: 'aporte', date, amount: amt, account_code: account };
    if (amt === null) out.questions.push({ field: 'amount', q: '¿Cuál fue el monto aportado?' });
    out.questions.push({ field: 'partner', q: '¿Qué socia realizó el aporte?' });
    if (!account) out.questions.push({ field: 'account_code', q: '¿A qué cuenta ingresó el dinero?' });
    return out;
  }
  return out;
}

function cap(s) { s = String(s || '').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
function singularPhrase(s) { return s.split(' ').map((w, i) => i === 0 ? singular(w) : w.replace(/(as|os)$/, m => m[0])).join(' '); }
function guessType(n) { return /\b(caja|bolsa|cinta|lazo|sticker|etiqueta|tarjeta|papel|acetato|pirulina|envoltura|mo\u00f1o|celofan)/.test(n) ? 'empaque' : /\b(guante|gorro|servilleta|film|aluminio|detergente|gas)/.test(n) ? 'suministro' : 'materia_prima'; }
function guessBase(u, n) { if (u === 'kg' || u === 'g') return 'g'; if (u === 'l' || u === 'ml') return 'ml'; if (u === 'm' || u === 'cm' || /\b(cinta|lazo)/.test(n)) return 'm'; return 'und'; }
function mapUnit(it, u) {
  const ok = { g: ['g', 'kg'], ml: ['ml', 'l'], und: ['und', 'docena', 'ciento'], m: ['m', 'cm'] }[it.base_unit] || [];
  if (u === 'pres') return it.pres_size ? 'pres' : null;
  return ok.includes(u) ? u : null;
}
function factorFor(it, u) { return { kg: 1000, g: 1, l: 1000, ml: 1, m: 1, cm: 0.01, und: 1, docena: 12, ciento: 100, pres: it.pres_size || null }[u] || null; }
function toBase(it, q, u) { const m = mapUnit(it, u); if (!m) return null; const f = factorFor(it, m); return f ? r6(q * f) : null; }

module.exports = { parse, norm, bestMatch, parseQtyPhrase, clauses };
