'use strict';
// Rutas de negocio de la API. Se usan en el servidor (Node) y en la versión que corre dentro del navegador.
const { AppError, bad, V, today, r2 } = require('./lib');
const { nowIso } = require('./db');
const L = require('./services/ledger');
const INV = require('./services/inventory');
const PU = require('./services/purchases');
const P = require('./services/production');
const PR = require('./services/presentations');
const S = require('./services/sales');
const FI = require('./services/finance');
const R = require('./services/reports');
const Q = require('./services/quick');
const SEED = require('./services/seed');
const EX = require('./export');
const { audit } = require('./services/audit');

/** Enrutador mínimo: registra rutas con patrón y nivel de acceso. */
function makeRouter() {
  const routes = [];
  const route = (method, pattern, handler, { role = 'operador', auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, role, auth });
  };
  const find = (method, pathname) => {
    const m = routes.find(r => r.method === method && r.re.test(pathname));
    if (!m) return null;
    const params = {}; const vals = pathname.match(m.re).slice(1); m.keys.forEach((k, i) => { params[k] = decodeURIComponent(vals[i]); });
    return { ...m, params };
  };
  return { routes, route, find, RANK: { lectura: 1, operador: 2, admin: 3 } };
}

/** Registra todas las rutas de negocio. opts.backup(tag) devuelve el nombre del respaldo creado (o null). */
function registerRoutes(route, db, { backup } = {}) {
  const read = { role: 'lectura' }, admin = { role: 'admin' };
  const id = p => V.id(p.id, 'id');

  // ---------- Metadatos y configuración ----------
  route('GET', '/api/meta', () => ({
    settings: Object.fromEntries(db.all("SELECT key, value FROM settings WHERE key NOT IN ('schema_version')").map(r => [r.key, r.value])),
    money: L.MONEY, expense_categories: Object.keys(L.EXPENSE_CATEGORIES), qualities: P.qualities(db), allocation_methods: P.ALLOCATION_METHODS,
    statuses: S.STATUSES, item_types: INV.ITEM_TYPES, today: today(),
  }), read);
  route('PUT', '/api/settings', (c) => {
    const allowed = ['company_name', 'allocation_method', 'expiry_alert_days', 'defect_stock_alert', 'waste_alert_pct', 'commission_pct', 'districts', 'channels'];
    db.tx(() => { for (const [k, v] of Object.entries(c.body)) if (allowed.includes(k)) db.setSetting(k, String(v)); audit(db, c, 'editar', 'configuracion', null, c.body); });
    return { ok: true };
  }, admin);

  // ---------- CRUD genérico de maestros ----------
  const masters = {
    suppliers: { fields: { name: ['str'], phone: ['str?'], doc: ['str?'], notes: ['str?'], active: ['bool'] } },
    customers: { fields: { name: ['str'], phone: ['str?'], district: ['str?'], channel: ['str?'], notes: ['str?'] }, created: true },
    partners: { fields: { name: ['str'], active: ['bool'] } },
    campaigns: { fields: { name: ['str'], start_date: ['date?'], end_date: ['date?'], notes: ['str?'] } },
    fixed_costs: { fields: { name: ['str'], monthly_amount: ['num'], active: ['bool'] } },
    budgets: { fields: { category: ['cat'], month: ['month'], amount: ['num'] } },
  };
  function cleanMaster(def, b) {
    const o = {};
    for (const [k, [t]] of Object.entries(def.fields)) {
      const v = b[k];
      if (t === 'str') o[k] = V.str(v, k === 'name' ? 'Nombre' : k);
      else if (t === 'str?') o[k] = V.str(v, k, { optional: true, max: 1000 });
      else if (t === 'date?') o[k] = v ? V.date(v) : null;
      else if (t === 'num') o[k] = V.num(v, 'Monto', { min: 0 });
      else if (t === 'bool') o[k] = v === undefined ? 1 : (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
      else if (t === 'cat') o[k] = V.oneOf(v, 'Categoría', Object.keys(L.EXPENSE_CATEGORIES));
      else if (t === 'month') { if (!(v === '*' || /^\d{4}-\d{2}$/.test(v || ''))) throw bad('Mes: use AAAA-MM o * (todos los meses).'); o[k] = v; }
    }
    return o;
  }
  for (const [table, def] of Object.entries(masters)) {
    route('GET', `/api/${table}`, () => db.all(`SELECT * FROM ${table} ORDER BY ${table === 'budgets' ? 'month DESC, category' : 'id DESC'}`), read);
    route('POST', `/api/${table}`, (c) => db.tx(() => { const o = cleanMaster(def, c.body); if (def.created) o.created_at = nowIso(); const nid = db.insert(table, o); audit(db, c, 'crear', table, nid, o); return { id: nid }; }));
    route('PUT', `/api/${table}/:id`, (c) => db.tx(() => { const o = cleanMaster(def, c.body); db.update(table, id(c.params), o); audit(db, c, 'editar', table, id(c.params), o); return { ok: true }; }));
  }

  // ---------- Insumos e inventario ----------
  route('GET', '/api/items', () => INV.listItems(db), read);
  route('POST', '/api/items', (c) => ({ id: INV.saveItem(db, c, c.body) }));
  route('PUT', '/api/items/:id', (c) => ({ id: INV.saveItem(db, c, c.body, id(c.params)) }));
  route('GET', '/api/items/:id/kardex', (c) => INV.kardex(db, id(c.params)), read);
  route('POST', '/api/items/:id/reference-price', (c) => db.tx(() => {
    const it = INV.getItem(db, id(c.params));
    INV.setReferencePrice(db, c, it.id, { price: V.num(c.body.price, 'Precio', { gt: 0 }), size: V.num(c.body.size || it.pres_size || 1, 'Tamaño', { gt: 0 }), label: c.body.label || it.pres_label, date: c.body.date || today(), note: c.body.note });
    audit(db, c, 'precio_referencia', 'insumo', it.id, c.body); return { ok: true };
  }));
  route('POST', '/api/inventory/consumptions', (c) => ({ id: INV.directConsumption(db, c, c.body) }));
  route('GET', '/api/inventory/consumptions', () => db.all('SELECT c.*, i.name, i.base_unit FROM item_consumptions c JOIN items i ON i.id=c.item_id ORDER BY c.id DESC'), read);
  route('POST', '/api/inventory/consumptions/:id/annul', (c) => { INV.annulConsumption(db, c, id(c.params), c.body.reason); return { ok: true }; });
  route('POST', '/api/inventory/counts', (c) => INV.physicalCount(db, c, c.body));
  route('GET', '/api/inventory/counts', () => db.all('SELECT c.*, i.name, i.base_unit FROM inventory_counts c LEFT JOIN items i ON i.id=c.item_id ORDER BY c.id DESC LIMIT 200'), read);
  route('POST', '/api/inventory/opening', (c) => ({ id: INV.openingItem(db, c, c.body) }));
  route('GET', '/api/inventory/value', () => R.inventoryValue(db), read);
  route('GET', '/api/assets', () => db.all('SELECT * FROM assets ORDER BY date DESC, id DESC'), read);
  route('PUT', '/api/assets/:id', (c) => db.tx(() => { const st = V.oneOf(c.body.status, 'Estado', ['activo', 'baja', 'anulado']); db.update('assets', id(c.params), { status: st, notes: c.body.notes || null }); audit(db, c, 'editar', 'activo', id(c.params), c.body); return { ok: true }; }));

  // ---------- Compras ----------
  route('GET', '/api/purchases', (c) => PU.listPurchases(db, c.query), read);
  route('POST', '/api/purchases', (c) => ({ id: PU.createPurchase(db, c, c.body) }));
  route('POST', '/api/purchases/:id/replace', (c) => ({ id: PU.replacePurchase(db, c, id(c.params), c.body) }));
  route('POST', '/api/purchases/:id/annul', (c) => { PU.annulPurchase(db, c, id(c.params), c.body.reason); return { ok: true }; });
  route('GET', '/api/supplier-payments', () => db.all('SELECT p.*, s.name supplier FROM supplier_payments p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC'), read);
  route('POST', '/api/supplier-payments', (c) => ({ id: PU.paySupplier(db, c, c.body) }));

  // ---------- Productos, calidades, recetas, producción ----------
  route('GET', '/api/products', () => db.all('SELECT * FROM products ORDER BY active DESC, name').map(p => ({ ...p, prices: Object.fromEntries(db.all('SELECT quality_id, price FROM product_prices WHERE product_id=?', p.id).map(r => [r.quality_id, r.price])) })), read);
  route('POST', '/api/products', (c) => ({ id: P.saveProduct(db, c, c.body) }));
  route('PUT', '/api/products/:id', (c) => ({ id: P.saveProduct(db, c, c.body, id(c.params)) }));
  route('GET', '/api/price-history', (c) => db.all('SELECT h.*, q.name quality FROM price_history h LEFT JOIN quality_categories q ON q.id=h.quality_id WHERE entity=? AND entity_id=? ORDER BY h.id DESC', c.query.entity, Number(c.query.id)), read);
  route('GET', '/api/qualities', () => P.qualities(db), read);
  route('POST', '/api/qualities', (c) => db.tx(() => { const o = qualityData(c.body); const nid = db.insert('quality_categories', o); audit(db, c, 'crear', 'calidad', nid, o); return { id: nid }; }), admin);
  route('PUT', '/api/qualities/:id', (c) => db.tx(() => {
    const o = qualityData(c.body); const old = db.get('SELECT * FROM quality_categories WHERE id=?', id(c.params));
    if (old.sellable !== o.sellable && db.get('SELECT 1 FROM fg_lots WHERE quality_id=? AND qty_available>0', old.id)) throw bad('No se puede cambiar si es comercializable mientras tenga stock.');
    db.update('quality_categories', old.id, o); audit(db, c, 'editar', 'calidad', old.id, o); return { ok: true };
  }), admin);
  function qualityData(b) { return { code: V.str(b.code, 'Código', { max: 5 }).toUpperCase(), name: V.str(b.name, 'Nombre'), description: b.description || null, sellable: b.sellable ? 1 : 0, cost_factor: V.num(b.cost_factor ?? 1, 'Factor de costo', { min: 0 }), sort: V.num(b.sort || 0, 'Orden'), active: b.active === undefined ? 1 : (b.active ? 1 : 0) }; }

  route('GET', '/api/recipes', () => db.all('SELECT r.*, p.name product FROM recipes r JOIN products p ON p.id=r.product_id ORDER BY r.active DESC, r.name').map(r => ({ ...r, ...pick(P.recipeCost(db, r.id), ['lines', 'materials', 'labor', 'overhead', 'total', 'unit_cost']) })), read);
  route('GET', '/api/recipes/:id/cost', (c) => P.recipeCost(db, id(c.params), c.query.qty ? Number(c.query.qty) : undefined), read);
  route('POST', '/api/recipes', (c) => ({ id: P.saveRecipe(db, c, c.body) }));
  route('PUT', '/api/recipes/:id', (c) => ({ id: P.saveRecipe(db, c, c.body, id(c.params)) }));
  route('GET', '/api/batches', (c) => P.listBatches(db, c.query), read);
  route('GET', '/api/batches/:id', (c) => P.batchDetail(db, id(c.params)), read);
  route('POST', '/api/batches', (c) => ({ id: P.createBatch(db, c, c.body) }));
  route('POST', '/api/batches/:id/annul', (c) => { P.annulBatch(db, c, id(c.params), c.body.reason); return { ok: true }; });
  route('POST', '/api/batches/preview', (c) => {
    // Vista previa del costeo sin registrar (no toca inventario)
    const b = c.body; const qty = V.num(b.qty_produced, 'Cantidad producida', { gt: 0 });
    let materials = 0; const lines = [];
    for (const x of b.consumptions || []) { if (!x.item_id || !(Number(x.qty) > 0)) continue; const it = INV.getItem(db, Number(x.item_id)); const uc = INV.currentCost(db, it.id); lines.push({ item_id: it.id, name: it.name, qty: Number(x.qty), stock: it.stock_qty, unit_cost: uc, cost: uc * Number(x.qty), short: Number(x.qty) > it.stock_qty + 1e-9 }); materials += uc * Number(x.qty); }
    const total = materials + Number(b.labor_cost || 0) + Number(b.overhead_cost || 0);
    const outputs = (b.outputs || []).map(o => ({ quality_id: Number(o.quality_id), qty: Number(o.qty || 0) }));
    const alloc = P.allocate(db, { total, product_id: Number(b.product_id), outputs, method: b.allocation_method || db.setting('allocation_method', 'igual') });
    const theo = b.recipe_id ? P.recipeCost(db, Number(b.recipe_id), qty) : null;
    return { lines, materials, total, unit_cost_produced: total / qty, outputs: alloc.outputs, lost: alloc.lost, theoretical: theo ? theo.total : null };
  });
  route('GET', '/api/fg/stock', () => P.fgStock(db), read);
  route('GET', '/api/fg/lots', (c) => P.fgLots(db, { available: c.query.all !== '1' }), read);
  route('GET', '/api/fg/lots/:id/movements', (c) => db.all('SELECT * FROM fg_movements WHERE lot_id=? ORDER BY id', id(c.params)), read);
  route('POST', '/api/fg/adjust', (c) => { P.adjustFg(db, c, c.body); return { ok: true }; });
  route('POST', '/api/fg/opening', (c) => ({ id: P.openingFg(db, c, c.body) }));

  // ---------- Presentaciones y armado ----------
  route('GET', '/api/presentations', () => PR.listPresentations(db), read);
  route('GET', '/api/presentations/:id', (c) => PR.presentationCost(db, id(c.params)), read);
  route('POST', '/api/presentations', (c) => ({ id: PR.savePresentation(db, c, c.body) }));
  route('PUT', '/api/presentations/:id', (c) => ({ id: PR.savePresentation(db, c, c.body, id(c.params)) }));
  route('GET', '/api/assemblies', () => db.all('SELECT a.*, p.name presentation, pl.qty_available FROM assemblies a JOIN presentations p ON p.id=a.presentation_id LEFT JOIN pack_lots pl ON pl.assembly_id=a.id ORDER BY a.id DESC'), read);
  route('POST', '/api/assemblies', (c) => PR.assemble(db, c, { ...c.body, date: V.date(c.body.date) }));
  route('POST', '/api/assemblies/:id/annul', (c) => { PR.annulAssembly(db, c, id(c.params), c.body.reason); return { ok: true }; });
  route('GET', '/api/packs/stock', () => PR.packStock(db), read);

  // ---------- Ventas ----------
  route('GET', '/api/sales', (c) => S.listSales(db, c.query), read);
  route('GET', '/api/sales/:id', (c) => S.saleDetail(db, id(c.params)), read);
  route('POST', '/api/sales', (c) => ({ id: S.createSale(db, c, c.body) }));
  route('PUT', '/api/sales/:id', (c) => ({ id: S.updateSale(db, c, id(c.params), c.body) }));
  route('POST', '/api/sales/:id/status', (c) => { S.setStatus(db, c, id(c.params), c.body.status, c.body); return S.saleDetail(db, id(c.params)); });
  route('POST', '/api/sales/:id/payments', (c) => ({ id: S.addPayment(db, c, id(c.params), c.body) }));
  route('POST', '/api/payments/:id/annul', (c) => { S.annulPayment(db, c, id(c.params), c.body.reason); return { ok: true }; });
  route('POST', '/api/sales/:id/returns', (c) => ({ id: S.addReturn(db, c, id(c.params), c.body) }));

  // ---------- Finanzas ----------
  route('GET', '/api/finance/summary', () => ({ money: FI.moneyBalances(db), receivables: FI.receivables(db), payables: FI.payables(db) }), read);
  route('GET', '/api/finance/movements', (c) => FI.moneyMovements(db, c.query), read);
  route('GET', '/api/expenses', (c) => db.all(`SELECT e.*, s.name supplier, cp.name campaign FROM expenses e LEFT JOIN suppliers s ON s.id=e.supplier_id LEFT JOIN campaigns cp ON cp.id=e.campaign_id ${c.query.from ? 'WHERE e.date BETWEEN ? AND ?' : ''} ORDER BY e.date DESC, e.id DESC`, ...(c.query.from ? [c.query.from, c.query.to || today()] : [])), read);
  route('POST', '/api/expenses', (c) => ({ id: FI.createExpense(db, c, c.body) }));
  route('GET', '/api/capital', () => db.all('SELECT m.*, p.name partner FROM capital_moves m JOIN partners p ON p.id=m.partner_id ORDER BY m.date DESC, m.id DESC'), read);
  route('POST', '/api/capital', (c) => ({ id: FI.capitalMove(db, c, c.body) }));
  route('GET', '/api/loans', () => db.all("SELECT l.*, COALESCE((SELECT SUM(principal) FROM loan_payments WHERE loan_id=l.id AND status='activo'),0) paid FROM loans l ORDER BY l.id DESC").map(l => ({ ...l, balance: r2(l.amount - l.paid), payments: db.all('SELECT * FROM loan_payments WHERE loan_id=? ORDER BY id', l.id) })), read);
  route('POST', '/api/loans', (c) => ({ id: FI.createLoan(db, c, c.body) }));
  route('POST', '/api/loans/:id/payments', (c) => ({ id: FI.payLoan(db, c, id(c.params), c.body) }));
  route('GET', '/api/transfers', () => db.all('SELECT * FROM transfers ORDER BY id DESC'), read);
  route('POST', '/api/transfers', (c) => ({ id: FI.transfer(db, c, c.body) }));
  route('POST', '/api/finance/annul', (c) => { FI.annul(db, c, c.body.type, V.id(c.body.id, 'id'), c.body.reason); return { ok: true }; });

  // ---------- Análisis y reportes ----------
  const range = q => ({ from: q.from || today().slice(0, 7) + '-01', to: q.to || today() });
  route('GET', '/api/dashboard', (c) => R.dashboard(db, c.query.month), read);
  route('GET', '/api/reports/income', (c) => R.incomeStatement(db, range(c.query)), read);
  route('GET', '/api/reports/cashflow', (c) => R.cashFlow(db, range(c.query)), read);
  route('GET', '/api/reports/balance', (c) => R.balanceSheet(db, c.query.to || today()), read);
  route('GET', '/api/reports/profitability', (c) => R.profitability(db, range(c.query)), read);
  route('GET', '/api/reports/breakeven', (c) => R.breakEven(db, { month: c.query.month, fixed: c.query.fixed, volume: c.query.volume, factors: c.query.factors ? JSON.parse(c.query.factors) : undefined }), read);
  route('GET', '/api/alerts', () => R.alerts(db), read);
  route('GET', '/api/export/:name', async (c) => {
    const rep = EX.build(db, c.params.name, c.query);
    const company = db.setting('company_name', 'Dhaline');
    if (c.query.format === 'xlsx') {
      const buf = await EX.toXlsx(rep, company);
      return { __raw: new Uint8Array(buf), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${c.params.name}_${today()}.xlsx` };
    }
    if (c.query.format === 'html') return { __raw: EX.toHtml(rep, company), type: 'text/html; charset=utf-8' };
    return rep;
  }, read);

  // ---------- Registro rápido ----------
  route('POST', '/api/quick/parse', (c) => Q.parse(db, V.str(c.body.text, 'Texto', { max: 1000 })));

  // ---------- Administración ----------
  route('GET', '/api/journal', (c) => {
    const rows = db.all(`SELECT e.*, u.username FROM journal_entries e LEFT JOIN users u ON u.id=e.user_id ${c.query.from ? 'WHERE e.date BETWEEN ? AND ?' : ''} ORDER BY e.id DESC LIMIT 500`, ...(c.query.from ? [c.query.from, c.query.to || today()] : []));
    for (const e of rows) e.lines = db.all('SELECT l.*, a.name FROM journal_lines l JOIN accounts a ON a.code=l.account_code WHERE entry_id=?', e.id);
    return rows;
  }, read);
  route('GET', '/api/audit', (c) => db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(Number(c.query.limit) || 300, 2000)), admin);
  route('GET', '/api/admin/integrity', () => integrity(db), read);
  route('POST', '/api/admin/demo', (c) => { try { SEED.loadDemo(db, c); } catch (e) { if (e instanceof AppError) throw e; throw bad(e.message); } audit(db, c, 'cargar_demo', 'sistema', null); return { ok: true }; }, admin);
  route('POST', '/api/admin/reset', (c) => {
    if (c.body.confirm !== 'INICIAR OPERACIONES REALES') throw bad('Escriba exactamente: INICIAR OPERACIONES REALES');
    const file = backup ? backup('antes-de-reinicio') : null;
    SEED.resetOperations(db); audit(db, c, 'reiniciar_operaciones', 'sistema', null, { backup: file });
    return { ok: true, backup: file };
  }, admin);
}

function pick(o, keys) { return Object.fromEntries(keys.map(k => [k, o[k]])); }

/** Verificación de consistencia: libro cuadrado y subledgers = cuentas contables. */
function integrity(db) {
  const b = L.balances(db);
  const items = Object.fromEntries(db.all('SELECT type, SUM(stock_value) v FROM items GROUP BY type').map(r => [r.type, r.v || 0]));
  const fg = db.get('SELECT COALESCE(SUM(qty_available*unit_cost),0) v FROM fg_lots').v;
  const pk = db.get('SELECT COALESCE(SUM(qty_available*unit_cost),0) v FROM pack_lots').v;
  const checks = [
    ['Libro diario cuadrado (debe = haber)', L.trialBalanceOk(db) ? 0 : 1, 0],
    ['Materia prima: kárdex vs contabilidad', items.materia_prima || 0, b['1301'] || 0],
    ['Empaques: kárdex vs contabilidad', items.empaque || 0, b['1302'] || 0],
    ['Suministros: kárdex vs contabilidad', items.suministro || 0, b['1303'] || 0],
    ['Productos terminados: lotes vs contabilidad', fg, b['1304'] || 0],
    ['Cajas armadas: lotes vs contabilidad', pk, b['1305'] || 0],
  ].map(([name, a, c]) => ({ name, subledger: r2(a), ledger: r2(c), ok: Math.abs(a - c) < 0.02 }));
  const bs = R.balanceSheet(db);
  checks.push({ name: 'Balance: activo = pasivo + patrimonio', subledger: bs.total_assets, ledger: r2(bs.total_liabilities + bs.total_equity), ok: bs.balanced });
  return { ok: checks.every(c => c.ok), checks };
}

module.exports = { makeRouter, registerRoutes, integrity };
