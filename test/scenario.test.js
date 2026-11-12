'use strict';
// Pruebas de escenario completo: compra → inventario → producción con merma → clasificación → empaque → venta → finanzas.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
const { createApp, integrity } = require('../server/app');
const INV = require('../server/services/inventory');
const PU = require('../server/services/purchases');
const P = require('../server/services/production');
const PR = require('../server/services/presentations');
const S = require('../server/services/sales');
const FI = require('../server/services/finance');
const R = require('../server/services/reports');
const Q = require('../server/services/quick');
const SEED = require('../server/services/seed');
const { today, monthRange } = require('../server/lib');

const close = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) < eps, `esperado ${b}, obtenido ${a}`);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-'));
  const { db } = createApp({ dbFile: path.join(dir, 't.db'), backupDir: path.join(dir, 'bk') });
  const ctx = { user: { id: 1, username: 'test', role: 'admin' } };
  const item = n => db.get('SELECT * FROM items WHERE name=?', n);
  const prod = n => db.get('SELECT id FROM products WHERE name=?', n).id;
  const q = c => db.get('SELECT id FROM quality_categories WHERE code=?', c).id;
  const pres = n => db.get('SELECT id FROM presentations WHERE name=?', n).id;
  return { db, ctx, item, prod, q, pres };
}
const D = today();

test('configuración inicial: costos históricos como referencia editable, sin stock ni dinero', () => {
  const { db, item } = fresh();
  const c = item('Cobertura de chocolate');
  assert.equal(c.stock_qty, 0); close(c.last_cost, 0.016, 1e-9);
  close(item('Chinchín').last_cost, 0.01, 1e-9);
  const assets = db.all("SELECT * FROM assets");
  assert.equal(assets.length, 2); assert.match(assets[0].capacity, /21 cavidades/);
  assert.ok(integrity(db).ok);
});

test('compra parcial de cajas: solo se cuesta lo consumido, el saldo queda en inventario', () => {
  const { db, ctx, item } = fresh();
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1101', lines: [{ kind: 'inventario', item_id: item('Caja para chocotejas').id, qty: 100, unit: 'und', total: 80 }] });
  INV.directConsumption(db, ctx, { date: D, item_id: item('Caja para chocotejas').id, qty: 15, destination: 'gasto', expense_category: 'operativo' });
  const c = item('Caja para chocotejas');
  assert.equal(c.stock_qty, 85); close(c.stock_value, 68);
  const is = R.incomeStatement(db, monthRange(D.slice(0, 7)));
  close(is.opex.find(o => o.code === '6101').amount, 12); // solo 15 cajas × 0.80
  assert.ok(integrity(db).ok);
});

test('promedio ponderado y consumo parcial (1 kg a 16 + 1 kg a 20, uso 200 g)', () => {
  const { db, ctx, item } = fresh();
  const id = item('Cobertura de chocolate').id;
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1102', lines: [{ kind: 'inventario', item_id: id, qty: 1, unit: 'kg', total: 16 }] });
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1102', lines: [{ kind: 'inventario', item_id: id, qty: 1, unit: 'kg', unit_price: 20 }] });
  const r = INV.consume(db, ctx, { item_id: id, qty: 200, date: D, ref_type: 'test', ref_id: 1 });
  close(r.cost, 3.6); const c = item('Cobertura de chocolate');
  assert.equal(c.stock_qty, 1800); close(c.stock_value, 32.4);
  // historial de precios conservado
  assert.equal(db.all("SELECT * FROM item_prices WHERE item_id=? AND source='compra'", id).length, 2);
});

test('no permite stock negativo sin autorización', () => {
  const { db, ctx, item } = fresh();
  assert.throws(() => INV.directConsumption(db, ctx, { date: D, item_id: item('Pecanas').id, qty: 10, destination: 'merma' }), /Stock insuficiente/);
  assert.equal(db.get('SELECT COUNT(*) n FROM item_consumptions').n, 0); // transacción revertida
});

function produce(env, method = 'igual') {
  const { db, ctx, item, prod, q } = env;
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1101', lines: [
    { kind: 'inventario', item_id: item('Cobertura de chocolate').id, qty: 1, unit: 'kg', total: 16 },
    { kind: 'inventario', item_id: item('Manjar blanco').id, qty: 1, unit: 'kg', total: 18 },
    { kind: 'inventario', item_id: item('Pecanas').id, qty: 1, unit: 'pres', total: 10 },
  ] });
  return P.createBatch(db, ctx, { date: D, product_id: prod('Chocoteja de pecanas'), qty_produced: 30, labor_cost: 3, overhead_cost: 1, allocation_method: method,
    consumptions: [{ item_id: item('Cobertura de chocolate').id, qty: 300 }, { item_id: item('Manjar blanco').id, qty: 180 }, { item_id: item('Pecanas').id, qty: 30 }],
    outputs: [{ quality_id: q('A'), qty: 24 }, { quality_id: q('B'), qty: 4 }, { quality_id: q('C'), qty: 2 }] });
}

test('producción 30 → 24 originales, 4 defectuosas, 2 no comercializables (costo igual)', () => {
  const env = fresh(); const { db } = env;
  const bid = produce(env);
  const b = P.batchDetail(db, bid);
  // materiales: 300g×0.016 + 180g×0.018 + 30g×0.04 = 4.8 + 3.24 + 1.2 = 9.24 ; + MO 3 + CIF 1 = 13.24
  close(b.materials_cost, 9.24); close(b.total_cost, 13.24);
  close(b.unit_cost_sellable, 13.24 / 28, 1e-6);
  close(b.waste_pct, 2 / 30, 1e-9); assert.equal(b.lots.length, 2); // C no entra a stock
  const stock = P.fgStock(db);
  assert.equal(stock.find(s => s.code === 'A').qty, 24); assert.equal(stock.find(s => s.code === 'B').qty, 4);
  close(stock.reduce((s, x) => s + x.value, 0), 13.24);
  assert.ok(integrity(db).ok, JSON.stringify(integrity(db)));
});

test('asignación ponderada por factor: la segunda absorbe menos costo', () => {
  const env = fresh(); const { db } = env;
  const b = P.batchDetail(db, produce(env, 'factor'));
  const a = b.outputs.find(o => o.code === 'A'), s = b.outputs.find(o => o.code === 'B');
  // pesos: 24×1 + 4×0.6 = 26.4 → unitario A = 13.24/26.4
  close(a.unit_cost, 13.24 / 26.4, 1e-6); close(s.unit_cost, 13.24 * 0.6 / 26.4, 1e-6);
  close(a.total_cost + s.total_cost, 13.24, 1e-6);
});

test('venta de originales y defectuosas con precios distintos; ingresos ≠ utilidad', () => {
  const env = fresh(); const { db, ctx, prod, q } = env; produce(env);
  const sid = S.createSale(db, ctx, { date: D, status: 'entregado', lines: [
    { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('A'), qty: 10, unit_price: 4 },
    { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('B'), qty: 4, unit_price: 2.5 },
  ], payment: { account_code: '1102', amount: 30 } });
  const s = S.saleDetail(db, sid);
  close(s.total, 50); close(s.paid, 30); assert.equal(s.pay_status, 'parcial'); close(s.balance, 20);
  close(s.cost_total, 14 * 13.24 / 28);
  const is = R.incomeStatement(db, monthRange(D.slice(0, 7)));
  close(is.net_sales, 50); close(is.cogs, 6.62); close(is.gross_profit, 43.38);
  // MO y CIF imputados: 4 aplicados al lote; la mitad de las unidades sigue en stock
  const prof = R.profitability(db, monthRange(D.slice(0, 7)));
  const sec = prof.second_quality; close(sec.revenue, 10); close(sec.sacrificed_vs_premium, 4 * 4 - 10);
  assert.ok(integrity(db).ok);
  // el precio de lista cambia y el costo histórico no
  P.setProductPrice(db, ctx, prod('Chocoteja de pecanas'), q('A'), 5);
  close(S.saleDetail(db, sid).cost_total, 6.62);
});

test('caja de 6: descuenta chocotejas y todos los empaques; trazabilidad por lote', () => {
  const env = fresh(); const { db, ctx, item, pres } = env; produce(env);
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1101', lines: [
    { kind: 'inventario', item_id: item('Caja para chocotejas').id, qty: 100, total: 80 }, { kind: 'inventario', item_id: item('Acetato').id, qty: 10, total: 5 },
    { kind: 'inventario', item_id: item('Pirulinas').id, qty: 100, total: 5 }, { kind: 'inventario', item_id: item('Envolturas').id, qty: 100, total: 0 },
    { kind: 'inventario', item_id: item('Lazo').id, qty: 10, total: 5 },
  ] });
  const sid = S.createSale(db, ctx, { date: D, status: 'listo', lines: [{ kind: 'presentacion', presentation_id: pres('Caja de 6'), qty: 2, unit_price: 12 }] });
  const s = S.saleDetail(db, sid);
  assert.equal(item('Caja para chocotejas').stock_qty, 98); assert.equal(item('Pirulinas').stock_qty, 88); assert.equal(item('Lazo').stock_qty, 8);
  const pack = 0.8 + 0.5 + 6 * 0.05 + 0 + 0.5;
  close(s.cost_total, 2 * (6 * 13.24 / 28 + pack));
  assert.ok(s.lines[0].trace.some(t => t.batch_code && t.batch_code.startsWith('L-')));
  // cancelación: devuelve stock y revierte asientos
  S.setStatus(db, ctx, sid, 'cancelado', { reason: 'cliente desistió' });
  assert.equal(db.get('SELECT SUM(qty_available) q FROM pack_lots').q, 2); // cajas quedan armadas
  close(R.incomeStatement(db, monthRange(D.slice(0, 7))).net_sales, 0);
  assert.ok(integrity(db).ok);
});

test('devolución con reingreso y anulación de compra consumida bloqueada', () => {
  const env = fresh(); const { db, ctx, prod, q, item } = env; produce(env);
  const sid = S.createSale(db, ctx, { date: D, status: 'entregado', lines: [{ kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('A'), qty: 5, unit_price: 4 }] });
  const line = S.saleDetail(db, sid).lines[0];
  S.addReturn(db, ctx, sid, { date: D, line_id: line.id, qty: 1, amount: 4, restock: true });
  const is = R.incomeStatement(db, monthRange(D.slice(0, 7)));
  close(is.returns, 4); close(is.net_sales, 16); close(is.cogs, 4 * 13.24 / 28);
  const pid = db.get('SELECT id FROM purchases').id;
  assert.throws(() => PU.annulPurchase(db, ctx, pid, 'error'), /ya fue consumido/);
  assert.ok(integrity(db).ok);
  // anulación limpia de una compra no consumida
  const p2 = PU.createPurchase(db, ctx, { date: D, pay_status: 'credito', supplier_id: db.insert('suppliers', { name: 'X' }), lines: [{ kind: 'inventario', item_id: item('Pasas').id, qty: 250, unit: 'g', total: 7 }] });
  PU.annulPurchase(db, ctx, p2, 'duplicada'); assert.equal(item('Pasas').stock_qty, 0);
  assert.equal(db.get('SELECT status FROM purchases WHERE id=?', p2).status, 'anulada');
  assert.ok(integrity(db).ok);
});

test('finanzas: aportes, gastos, préstamo, transferencias y flujo de caja', () => {
  const { db, ctx } = fresh();
  const pa = db.insert('partners', { name: 'Socia 1' });
  FI.capitalMove(db, ctx, { date: D, partner_id: pa, type: 'aporte', amount: 126.5, account_code: '1101' });
  FI.createExpense(db, ctx, { date: D, category: 'marketing', description: 'Anuncio', amount: 10, account_code: '1102', pay_status: 'pagado' });
  FI.transfer(db, ctx, { date: D, from_account: '1101', to_account: '1102', amount: 50 });
  const lid = FI.createLoan(db, ctx, { date: D, lender: 'Tía', amount: 100, account_code: '1101' });
  FI.payLoan(db, ctx, lid, { date: D, principal: 40, interest: 2, account_code: '1101' });
  const m = Object.fromEntries(FI.moneyBalances(db).map(x => [x.code, x.balance]));
  close(m['1101'], 126.5 - 50 + 100 - 42); close(m['1102'], 40);
  const cf = R.cashFlow(db, monthRange(D.slice(0, 7)));
  close(cf.closing, 126.5 + 100 - 42 - 10); close(cf.financing, 126.5 + 100 - 42);
  const is = R.incomeStatement(db, monthRange(D.slice(0, 7)));
  close(is.net_income, -12); // 10 marketing + 2 intereses; el aporte no es ingreso
  assert.ok(integrity(db).ok);
});

test('punto de equilibrio multiproducto basado en mezcla de ventas', () => {
  const env = fresh(); const { db, ctx, prod, q } = env; produce(env);
  db.insert('fixed_costs', { name: 'Fijos', monthly_amount: 30 });
  S.createSale(db, ctx, { date: D, status: 'entregado', lines: [
    { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('A'), qty: 12, unit_price: 2 },
    { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('B'), qty: 4, unit_price: 1 },
  ] });
  const be = R.breakEven(db, { month: D.slice(0, 7) });
  const uc = 13.24 / 28;
  const wcm = 0.75 * (2 - uc) + 0.25 * (1 - uc);
  close(be.weighted_cm, wcm); close(be.be_units, 30 / wcm, 0.02);
  close(be.skus.reduce((s, k) => s + k.be_units, 0), be.be_units, 0.03);
  assert.equal(be.scenarios.length, 3);
});

test('registro rápido: interpreta los 5 ejemplos sin inventar datos', () => {
  const { db } = fresh();
  const a = Q.parse(db, 'Hoy compré 2 kg de cobertura a S/ 32 y 50 cajas pequeñas a S/ 40');
  assert.equal(a.type, 'compra'); assert.equal(a.draft.lines.length, 2);
  assert.equal(a.draft.lines[0].item_name, 'Cobertura de chocolate'); assert.equal(a.draft.lines[0].qty, 2); assert.equal(a.draft.lines[0].unit, 'kg'); assert.equal(a.draft.lines[0].total, 32);
  assert.equal(a.draft.lines[1].item_name, 'Caja para chocotejas'); assert.equal(a.draft.lines[1].qty, 50); assert.equal(a.draft.lines[1].total, 40);
  assert.ok(a.questions.some(x => x.field === 'account_code'));

  const b = Q.parse(db, 'Utilicé 300 gramos de cobertura, 200 gramos de manjar y 20 pecanas para producir 25 chocotejas');
  assert.equal(b.type, 'produccion'); assert.equal(b.draft.qty_produced, 25);
  assert.equal(b.draft.consumptions[0].qty, 300); assert.equal(b.draft.consumptions[1].qty, 200);
  assert.equal(b.draft.consumptions[2].qty, null); // "20 pecanas" no son gramos: se pregunta
  assert.ok(b.questions.some(x => x.field === 'unit'));

  const c = Q.parse(db, 'Compré cintas rojas por S/ 12 y utilicé 8 metros para decorar las cajas navideñas');
  assert.equal(c.type, 'compra'); assert.equal(c.draft.lines[0].total, 12);
  assert.ok(c.questions.some(x => x.field === 'qty')); assert.ok(c.consumption && c.consumption.lines[0].qty === 8);

  const d = Q.parse(db, 'Vendí 10 chocotejas originales a S/ 4 y 5 defectuosas a S/ 2.50');
  assert.equal(d.type, 'venta'); assert.equal(d.draft.lines.length, 2);
  assert.equal(d.draft.lines[0].unit_price, 4); assert.equal(d.draft.lines[1].unit_price, 2.5);
  assert.equal(d.draft.lines[0].quality, 'Original / Premium'); assert.equal(d.draft.lines[1].quality, 'Segunda / Defectuosa');
  assert.ok(d.questions.some(x => x.field === 'product'));

  const e = Q.parse(db, 'Compré utensilios por S/ 35 para el emprendimiento');
  assert.equal(e.type, 'compra'); assert.equal(e.draft.lines[0].kind, 'activo'); assert.equal(e.draft.lines[0].total, 35);
});

test('datos demo: escenario completo cuadra y se eliminan antes de operar', () => {
  const { db, ctx } = fresh();
  SEED.loadDemo(db, ctx);
  assert.ok(db.get('SELECT COUNT(*) n FROM sales').n >= 3);
  const ig = integrity(db); assert.ok(ig.ok, JSON.stringify(ig));
  const dash = R.dashboard(db);
  assert.ok(dash.kpis.net_sales > 0); assert.ok(dash.kpis.inventory > 0);
  SEED.resetOperations(db);
  assert.equal(db.get('SELECT COUNT(*) n FROM sales').n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM customers WHERE is_demo=1").n, 0);
  assert.equal(db.get('SELECT SUM(stock_qty) s FROM items').s, 0);
  assert.ok(integrity(db).ok);
});

test('corregir compra: reemplaza la original aunque parte ya se haya usado, sin duplicar stock ni dinero', () => {
  const { db, ctx, item } = fresh();
  const id = item('Cobertura de chocolate').id;
  const p1 = PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1101', lines: [{ kind: 'inventario', item_id: id, qty: 1, unit: 'kg', total: 16 }] });
  INV.directConsumption(db, ctx, { date: D, item_id: id, qty: 300, destination: 'merma' });
  // Se equivocó: eran 2 kg por S/ 30
  const p2 = PU.replacePurchase(db, ctx, p1, { date: D, pay_status: 'pagado', account_code: '1101', lines: [{ kind: 'inventario', item_id: id, qty: 2, unit: 'kg', total: 30 }] });
  assert.equal(db.get('SELECT status FROM purchases WHERE id=?', p1).status, 'anulada');
  assert.equal(db.get('SELECT status FROM purchases WHERE id=?', p2).status, 'activa');
  assert.equal(item('Cobertura de chocolate').stock_qty, 1700);
  const cash = Object.fromEntries(FI.moneyBalances(db).map(x => [x.code, x.balance]));
  close(cash['1101'], -30);
  assert.ok(integrity(db).ok, JSON.stringify(integrity(db)));
});

test('recuperación de la inversión: aportes netos vs cobros', () => {
  const env = fresh(); const { db, ctx, prod, q } = env; produce(env);
  const pa = db.insert('partners', { name: 'Socia' });
  FI.capitalMove(db, ctx, { date: D, partner_id: pa, type: 'aporte', amount: 126.5, account_code: '1101' });
  S.createSale(db, ctx, { date: D, status: 'entregado', lines: [{ kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: q('A'), qty: 5, unit_price: 2.6 }], payment: { account_code: '1102', amount: 13 } });
  const r = R.recovery(db);
  close(r.invested, 126.5); close(r.collected, 13); close(r.pending, 113.5);
  assert.ok(r.days_left > 0 && r.eta);
});

test('cambiar tipo de insumo con stock reclasifica su valor sin descuadrar', () => {
  const { db, ctx } = fresh();
  const id = INV.saveItem(db, ctx, { name: 'DUPLEX', type: 'materia_prima', base_unit: 'und', pres_label: 'pliego dúplex', pres_size: 6 });
  PU.createPurchase(db, ctx, { date: D, pay_status: 'pagado', account_code: '1101', lines: [{ kind: 'inventario', item_id: id, qty: 1, unit: 'pres', total: 1.5 }] });
  INV.saveItem(db, ctx, { name: 'DUPLEX', type: 'empaque', base_unit: 'und', pres_label: 'pliego dúplex', pres_size: 6 }, id);
  const ig = integrity(db); assert.ok(ig.ok, JSON.stringify(ig));
  close(ig.checks.find(c => c.name.startsWith('Empaques')).ledger, 1.5);
});
