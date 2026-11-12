'use strict';
// Configuración inicial (datos reales editables de Dhaline) y datos de demostración eliminables.
const { today, addDays } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const INV = require('./inventory');
const P = require('./production');
const PR = require('./presentations');
const PU = require('./purchases');
const S = require('./sales');
const FI = require('./finance');

const SYS = { user: { id: null, username: 'sistema', role: 'admin' } };

function seedBase(db) {
  if (db.setting('base_seeded') === '1') return;
  db.tx(() => {
    L.seedAccounts(db);
    const defaults = {
      company_name: 'Dhaline', app_name: 'Chocolate Business Manager', allocation_method: 'igual', expiry_alert_days: '3',
      defect_stock_alert: '10', waste_alert_pct: '15', commission_pct: '0', districts: 'Campoy,Los Olivos,Ventanilla',
      channels: 'Instagram,TikTok,WhatsApp,Familia,Referido,Otro',
    };
    for (const [k, v] of Object.entries(defaults)) if (db.setting(k) === null) db.setSetting(k, v);

    const q = [
      ['A', 'Original / Premium', 'Presentación perfecta, acabado correcto y diseño aprobado. Precio regular.', 1, 1, 1],
      ['B', 'Segunda / Defectuosa', 'Imperfecciones visuales, decoración irregular o tamaño distinto. No afecta la inocuidad. Precio diferenciado.', 1, 0.6, 2],
      ['C', 'No comercializable', 'Rota, contaminada o sin condiciones de inocuidad. No ingresa al stock: es merma.', 0, 0, 3],
    ];
    for (const [code, name, description, sellable, cost_factor, sort] of q) db.run('INSERT OR IGNORE INTO quality_categories(code,name,description,sellable,cost_factor,sort) VALUES(?,?,?,?,?,?)', code, name, description, sellable, cost_factor, sort);
    const qA = db.get("SELECT id FROM quality_categories WHERE code='A'").id, qB = db.get("SELECT id FROM quality_categories WHERE code='B'").id;

    // Costos históricos de referencia (editables; no generan stock ni dinero)
    const items = [
      ['Manjar blanco', 'materia_prima', 'Rellenos', 'g', '1 kg', 1000, 18, 'manjar'],
      ['Cobertura de chocolate', 'materia_prima', 'Chocolates y coberturas', 'g', '1 kg', 1000, 16, 'cobertura,chocolate'],
      ['Pecanas', 'materia_prima', 'Frutos secos', 'g', 'bolsa 250 g', 250, 10, 'pecana,nuez pecana'],
      ['Almendras', 'materia_prima', 'Frutos secos', 'g', 'bolsa 250 g', 250, 10, 'almendra'],
      ['Pasas', 'materia_prima', 'Frutos secos', 'g', 'bolsa 250 g', 250, 7, 'pasa,pasitas'],
      ['Chinchín', 'materia_prima', 'Ingredientes adicionales', 'g', 'bolsa 250 g', 250, 2.5, 'chinchin'],
      ['Grajeas', 'materia_prima', 'Decoración', 'g', null, null, null, 'grajea,sprinkles'],
      ['Caja para chocotejas', 'empaque', 'Cajas y empaques', 'und', null, null, null, 'caja,cajas pequeñas,caja pequena'],
      ['Acetato', 'empaque', 'Materiales de protección', 'und', null, null, null, 'acetato,mica'],
      ['Pirulinas', 'empaque', 'Cajas y empaques', 'und', null, null, null, 'pirulina,capacillo,pirotin'],
      ['Envolturas', 'empaque', 'Cajas y empaques', 'und', null, null, null, 'envoltura,papel envoltura'],
      ['Lazo', 'empaque', 'Cintas y lazos', 'und', null, null, null, 'lazo,cinta,moño'],
      ['Stickers', 'empaque', 'Stickers y etiquetas', 'und', null, null, null, 'sticker,etiqueta'],
      ['Tarjetas', 'empaque', 'Tarjetas', 'und', null, null, null, 'tarjeta'],
    ];
    const ids = {};
    for (const [name, type, category, base_unit, pres_label, pres_size, price, aliases] of items) {
      const id = db.insert('items', { name, type, category, base_unit, pres_label, pres_size, aliases, min_stock: 0, created_at: nowIso() });
      if (price) INV.setReferencePrice(db, SYS, id, { price, size: pres_size, label: pres_label, date: '2026-10-01', note: 'Costo histórico registrado' });
      ids[name] = id;
    }
    // Productos y precios a probar (S/ 2 suelta original, S/ 1 defectuosa)
    const products = [['Chocoteja de chinchín', 'chinchin'], ['Chocoteja de pasas', 'pasas,pasa'], ['Chocoteja de pecanas', 'pecana,pecanas'], ['Cuadrado de chocolate', 'cuadrado,cuadrados']];
    const pid = {};
    for (const [name, aliases] of products) {
      pid[name] = db.insert('products', { name, family: name.startsWith('Choco') ? 'Chocotejas' : 'Bombones', shelf_life_days: 15, aliases });
      if (name.startsWith('Choco')) { P.setProductPrice(db, SYS, pid[name], qA, 2, today()); P.setProductPrice(db, SYS, pid[name], qB, 1, today()); }
    }
    // Presentaciones a probar (estructura de empaque propuesta, editable)
    const box = (name, n, price, extra = []) => PR.savePresentation(db, SYS, {
      name, quality_id: qA, price, description: 'Estructura de empaque propuesta: revise y ajuste.',
      components: [{ kind: 'producto', product_id: null, qty: n }, { kind: 'empaque', item_id: ids['Caja para chocotejas'], qty: 1 }, { kind: 'empaque', item_id: ids['Acetato'], qty: 1 },
        { kind: 'empaque', item_id: ids['Pirulinas'], qty: n }, { kind: 'empaque', item_id: ids['Envolturas'], qty: n }, { kind: 'empaque', item_id: ids['Lazo'], qty: 1 }, ...extra],
    });
    box('Caja de 4', 4, 10); box('Caja de 5', 5, 11); box('Caja de 6', 6, 12);
    box('Caja premium', 6, 15, [{ kind: 'empaque', item_id: ids['Tarjetas'], qty: 1 }, { kind: 'empaque', item_id: ids['Stickers'], qty: 1 }]);
    db.run("UPDATE presentations SET description='Precio tentativo. Estructura de empaque propuesta: revise y ajuste.' WHERE name='Caja de 5'");
    seedOpening(db);
    db.setSetting('base_seeded', '1');
  });
}

/** Moldes ya adquiridos antes de usar el sistema: activos con saldo de apertura. */
function seedOpening(db) {
  const date = '2026-10-01';
  for (const [name, cap] of [['Moldes de chocotejas (juego de 3)', '21 cavidades por molde'], ['Moldes cuadrados (juego de 3)', '12 cavidades por molde']]) {
    const id = db.insert('assets', { name, category: 'Moldes', qty: 3, unit_cost: 5 / 3, total_cost: 5, date, capacity: cap, notes: 'Costo histórico: 3 unidades por S/ 5.00' });
    L.post(db, SYS, { date, description: `Activo de apertura: ${name}`, ref_type: 'activo_apertura', ref_id: id, lines: [{ account: '1401', debit: 5 }, { account: '3103', credit: 5 }] });
  }
}

const TX_TABLES = ['journal_lines', 'journal_entries', 'inventory_movements', 'item_prices_purchases', 'purchase_lines', 'purchases', 'batch_consumptions', 'batch_outputs', 'fg_movements',
  'sale_cost_details', 'sale_allocations', 'sale_returns', 'sale_payments', 'sale_lines', 'sales', 'pack_lots', 'assembly_consumptions', 'assemblies', 'fg_lots', 'batches',
  'expenses', 'supplier_payments', 'loan_payments', 'loans', 'capital_moves', 'transfers', 'item_consumptions', 'inventory_counts', 'assets'];

/**
 * Elimina TODOS los movimientos (demo incluidos) y los maestros marcados como DEMO, dejando el catálogo y los usuarios.
 * Pensado para usarse una sola vez antes de iniciar operaciones reales. Se hace copia de seguridad antes.
 */
function resetOperations(db) {
  db.tx(() => {
    for (const t of TX_TABLES) {
      if (t === 'item_prices_purchases') { db.run("DELETE FROM item_prices WHERE source='compra'"); continue; }
      db.run(`DELETE FROM ${t}`);
    }
    for (const t of ['customers', 'suppliers', 'partners', 'campaigns', 'fixed_costs', 'recipe_lines', 'recipes', 'presentation_components', 'presentations', 'products', 'items']) {
      if (t === 'recipe_lines') { db.run('DELETE FROM recipe_lines WHERE recipe_id IN (SELECT id FROM recipes WHERE is_demo=1)'); continue; }
      if (t === 'presentation_components') { db.run('DELETE FROM presentation_components WHERE presentation_id IN (SELECT id FROM presentations WHERE is_demo=1)'); continue; }
      db.run(`DELETE FROM ${t} WHERE is_demo=1`);
    }
    db.run('DELETE FROM budgets');
    db.run('UPDATE items SET stock_qty=0, stock_value=0, last_cost=COALESCE((SELECT unit_cost FROM item_prices p WHERE p.item_id=items.id ORDER BY date DESC, id DESC LIMIT 1),0)');
    seedOpening(db);
    db.setSetting('demo_loaded', '0');
    db.setSetting('real_operations_since', today());
  });
}

/** Escenario de demostración completo: compra → producción con merma → clasificación → armado → venta → cobro → gasto. */
function loadDemo(db, ctx) {
  if (db.setting('demo_loaded') === '1') throw new Error('Los datos de demostración ya están cargados.');
  if (db.get("SELECT 1 FROM sales WHERE is_demo=0 LIMIT 1") || db.get("SELECT 1 FROM purchases WHERE is_demo=0 LIMIT 1")) throw new Error('Ya hay operaciones reales registradas: no se cargan datos de demostración para no mezclarlos.');
  const c = { ...ctx };
  db.tx(() => {
    const d0 = addDays(today(), -6), d1 = addDays(today(), -5), d2 = addDays(today(), -4), d3 = addDays(today(), -2);
    const item = n => db.get('SELECT id FROM items WHERE name=?', n).id;
    const prod = n => db.get('SELECT id FROM products WHERE name=?', n).id;
    const qual = code => db.get('SELECT id FROM quality_categories WHERE code=?', code).id;
    const pres = n => db.get('SELECT id FROM presentations WHERE name=?', n).id;
    const sup = db.insert('suppliers', { name: 'Proveedor DEMO (insumos)', is_demo: 1 });
    const sA = db.insert('partners', { name: 'Socia DEMO A', is_demo: 1 }); const sB = db.insert('partners', { name: 'Socia DEMO B', is_demo: 1 });
    const cust1 = db.insert('customers', { name: 'Cliente DEMO – Ana', district: 'Los Olivos', channel: 'Instagram', is_demo: 1, created_at: nowIso() });
    const cust2 = db.insert('customers', { name: 'Cliente DEMO – Luis', district: 'Ventanilla', channel: 'WhatsApp', is_demo: 1, created_at: nowIso() });
    const camp = db.insert('campaigns', { name: 'Navidad 2026 (DEMO)', start_date: '2026-11-01', end_date: '2026-12-31', is_demo: 1 });
    db.insert('fixed_costs', { name: 'Publicidad mensual (DEMO)', monthly_amount: 20, is_demo: 1 });
    db.insert('fixed_costs', { name: 'Gas y servicios (DEMO)', monthly_amount: 10, is_demo: 1 });
    FI.capitalMove(db, c, { date: d0, partner_id: sA, type: 'aporte', amount: 150, account_code: '1102', notes: 'DEMO', is_demo: 1 });
    FI.capitalMove(db, c, { date: d0, partner_id: sB, type: 'aporte', amount: 100, account_code: '1101', notes: 'DEMO', is_demo: 1 });
    PU.createPurchase(db, c, { date: d0, supplier_id: sup, pay_status: 'pagado', account_code: '1102', notes: 'Compra DEMO', is_demo: 1, lines: [
      { kind: 'inventario', item_id: item('Cobertura de chocolate'), qty: 1, unit: 'kg', total: 16 },
      { kind: 'inventario', item_id: item('Manjar blanco'), qty: 1, unit: 'kg', total: 18 },
      { kind: 'inventario', item_id: item('Pecanas'), qty: 1, unit: 'pres', total: 10 },
      { kind: 'inventario', item_id: item('Caja para chocotejas'), qty: 100, unit: 'und', total: 80 },
      { kind: 'inventario', item_id: item('Acetato'), qty: 20, unit: 'und', total: 6 },
      { kind: 'inventario', item_id: item('Pirulinas'), qty: 1, unit: 'ciento', total: 5 },
      { kind: 'inventario', item_id: item('Envolturas'), qty: 100, unit: 'und', total: 8 },
      { kind: 'inventario', item_id: item('Lazo'), qty: 20, unit: 'und', total: 10 },
    ] });
    PU.createPurchase(db, c, { date: d0, supplier_id: sup, pay_status: 'pagado', account_code: '1101', is_demo: 1, lines: [{ kind: 'activo', description: 'Espátula y bowl (DEMO)', category: 'Herramientas y utensilios', qty: 1, total: 15 }] });
    const rid = P.saveRecipe(db, c, { name: 'Chocoteja de pecanas – ficha DEMO', product_id: prod('Chocoteja de pecanas'), yield_qty: 30, labor_minutes: 90, labor_cost: 0, overhead_cost: 1.5, is_demo: 1, notes: 'Ficha DEMO: 10 g de cobertura, 6 g de manjar y 1 g de pecana por unidad.', lines: [
      { item_id: item('Cobertura de chocolate'), qty: 300 }, { item_id: item('Manjar blanco'), qty: 180 }, { item_id: item('Pecanas'), qty: 30 },
    ] });
    // Lote real vs teórico: se usó algo más de cobertura que la ficha; 24 originales, 4 de segunda, 2 no comercializables
    P.createBatch(db, c, { date: d1, product_id: prod('Chocoteja de pecanas'), recipe_id: rid, qty_produced: 30, minutes: 100, labor_cost: 0, overhead_cost: 1.5, allocation_method: 'igual', campaign_id: camp, is_demo: 1, notes: 'Lote DEMO',
      consumptions: [{ item_id: item('Cobertura de chocolate'), qty: 320 }, { item_id: item('Manjar blanco'), qty: 180 }, { item_id: item('Pecanas'), qty: 30 }],
      outputs: [{ quality_id: qual('A'), qty: 24 }, { quality_id: qual('B'), qty: 4 }, { quality_id: qual('C'), qty: 2 }] });
    PR.assemble(db, c, { presentation_id: pres('Caja de 6'), qty: 2, date: d2, notes: 'Armado DEMO', is_demo: 1 });
    const s1 = S.createSale(db, c, { date: d2, customer_id: cust1, channel: 'Instagram', campaign_id: camp, status: 'entregado', is_demo: 1, lines: [
      { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: qual('A'), qty: 10, unit_price: 4 },
      { kind: 'producto', product_id: prod('Chocoteja de pecanas'), quality_id: qual('B'), qty: 4, unit_price: 2.5 },
    ], payment: { account_code: '1102', amount: 50 } });
    S.createSale(db, c, { date: d3, customer_id: cust2, channel: 'WhatsApp', campaign_id: camp, status: 'entregado', delivery_charge: 3, delivery_cost: 3, delivery_account: '1101', is_demo: 1, lines: [
      { kind: 'presentacion', presentation_id: pres('Caja de 6'), qty: 1, unit_price: 12 },
    ], payment: { account_code: '1103', amount: 10 } });
    S.createSale(db, c, { date: today(), customer_id: cust1, channel: 'Instagram', campaign_id: camp, status: 'pendiente', is_demo: 1, lines: [
      { kind: 'presentacion', presentation_id: pres('Caja de 4'), qty: 1, unit_price: 10 },
    ] });
    FI.createExpense(db, c, { date: d3, category: 'marketing', description: 'Anuncio Instagram (DEMO)', amount: 10, pay_status: 'pagado', account_code: '1102', campaign_id: camp, is_demo: 1 });
    void s1;
    db.setSetting('demo_loaded', '1');
  });
}

module.exports = { seedBase, resetOperations, loadDemo };
