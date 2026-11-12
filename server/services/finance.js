'use strict';
// Gastos, aportes/retiros de socias, préstamos, transferencias, caja y bancos.
const { bad, r2, V } = require('../lib');
const { nowIso } = require('../db');
const L = require('./ledger');
const { audit } = require('./audit');

function createExpense(db, ctx, b) {
  const date = V.date(b.date);
  const category = V.oneOf(b.category, 'Categoría', Object.keys(L.EXPENSE_CATEGORIES));
  const amount = V.num(b.amount, 'Monto', { gt: 0 });
  const pay_status = V.oneOf(b.pay_status || 'pagado', 'Estado de pago', ['pagado', 'pendiente']);
  const acc = pay_status === 'pagado' ? L.checkMoney(b.account_code) : null;
  const description = V.str(b.description, 'Descripción');
  return db.tx(() => {
    const id = db.insert('expenses', { date, category, description, amount, pay_status, account_code: acc, supplier_id: V.optId(b.supplier_id), campaign_id: V.optId(b.campaign_id), sale_id: b.sale_id || null, voucher: b.voucher || null, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, { date, description: `Gasto: ${description}`, ref_type: 'gasto', ref_id: id, lines: [{ account: L.expenseAccount(category), debit: amount }, { account: acc || '2101', credit: amount }] });
    audit(db, ctx, 'crear', 'gasto', id, b);
    return id;
  });
}

function capitalMove(db, ctx, b) {
  const date = V.date(b.date); const partner_id = V.id(b.partner_id, 'Socia');
  const type = V.oneOf(b.type, 'Tipo', ['aporte', 'retiro']); const amount = V.num(b.amount, 'Monto', { gt: 0 });
  const acc = L.checkMoney(b.account_code);
  return db.tx(() => {
    const p = db.get('SELECT * FROM partners WHERE id=?', partner_id); if (!p) throw bad('Socia no encontrada.');
    const id = db.insert('capital_moves', { partner_id, date, type, amount, account_code: acc, notes: b.notes || null, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, {
      date, description: `${type === 'aporte' ? 'Aporte de capital' : 'Retiro'}: ${p.name}`, ref_type: 'capital', ref_id: id,
      lines: type === 'aporte' ? [{ account: acc, debit: amount }, { account: '3101', credit: amount }] : [{ account: '3102', debit: amount }, { account: acc, credit: amount }],
    });
    audit(db, ctx, 'crear', 'capital', id, b);
    return id;
  });
}

function createLoan(db, ctx, b) {
  const date = V.date(b.date); const lender = V.str(b.lender, 'Prestamista'); const amount = V.num(b.amount, 'Monto', { gt: 0 }); const acc = L.checkMoney(b.account_code);
  return db.tx(() => {
    const id = db.insert('loans', { lender, date, amount, account_code: acc, notes: b.notes || null, is_demo: b.is_demo ? 1 : 0, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, { date, description: `Préstamo recibido de ${lender}`, ref_type: 'prestamo', ref_id: id, lines: [{ account: acc, debit: amount }, { account: '2201', credit: amount }] });
    audit(db, ctx, 'crear', 'prestamo', id, b);
    return id;
  });
}
function payLoan(db, ctx, loanId, b) {
  const date = V.date(b.date); const principal = V.num(b.principal || 0, 'Capital', { min: 0 }); const interest = V.num(b.interest || 0, 'Interés', { min: 0 });
  if (principal + interest <= 0) throw bad('Indique el monto pagado.');
  const acc = L.checkMoney(b.account_code);
  return db.tx(() => {
    const ln = db.get('SELECT * FROM loans WHERE id=?', loanId); if (!ln || ln.status !== 'activo') throw bad('Préstamo no encontrado.');
    const paid = db.get("SELECT COALESCE(SUM(principal),0) p FROM loan_payments WHERE loan_id=? AND status='activo'", loanId).p;
    if (principal > ln.amount - paid + 0.001) throw bad(`El pago de capital supera el saldo del préstamo (S/ ${r2(ln.amount - paid)}).`);
    const id = db.insert('loan_payments', { loan_id: loanId, date, principal, interest, account_code: acc, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, { date, description: `Pago de préstamo a ${ln.lender}`, ref_type: 'pago_prestamo', ref_id: id, lines: [{ account: '2201', debit: principal }, { account: '6109', debit: interest }, { account: acc, credit: principal + interest }] });
    audit(db, ctx, 'crear', 'pago_prestamo', id, b);
    return id;
  });
}

function transfer(db, ctx, b) {
  const date = V.date(b.date); const from = L.checkMoney(b.from_account); const to = L.checkMoney(b.to_account);
  if (from === to) throw bad('Las cuentas de origen y destino deben ser distintas.');
  const amount = V.num(b.amount, 'Monto', { gt: 0 });
  return db.tx(() => {
    const id = db.insert('transfers', { date, from_account: from, to_account: to, amount, notes: b.notes || null, created_at: nowIso(), user_id: ctx.user?.id });
    L.post(db, ctx, { date, description: `Transferencia ${L.MONEY[from]} → ${L.MONEY[to]}`, ref_type: 'transferencia', ref_id: id, lines: [{ account: to, debit: amount }, { account: from, credit: amount }] });
    audit(db, ctx, 'crear', 'transferencia', id, b);
    return id;
  });
}

// Anulación genérica de operaciones financieras simples
const ANNULLABLE = {
  gasto: 'expenses', capital: 'capital_moves', prestamo: 'loans', pago_prestamo: 'loan_payments',
  transferencia: 'transfers', pago_proveedor: 'supplier_payments',
};
function annul(db, ctx, type, id, reason) {
  const table = ANNULLABLE[type]; if (!table) throw bad('Tipo no anulable.');
  if (!reason) throw bad('Indique el motivo de la anulación.');
  return db.tx(() => {
    const r = db.get(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!r || r.status !== 'activo') throw bad('Registro no encontrado o ya anulado.');
    if (type === 'prestamo' && db.get("SELECT 1 FROM loan_payments WHERE loan_id=? AND status='activo'", id)) throw bad('Anule primero los pagos de este préstamo.');
    L.reverseRef(db, ctx, type, id, reason);
    db.update(table, id, { status: 'anulado', annul_reason: reason });
    if (type === 'gasto' && r.sale_id) db.run('UPDATE sales SET delivery_expense_id=NULL WHERE id=? AND delivery_expense_id=?', r.sale_id, id);
    audit(db, ctx, 'anular', type, id, { reason });
  });
}

function moneyBalances(db, to) {
  const b = L.balances(db, { to });
  return Object.entries(L.MONEY).map(([code, name]) => ({ code, name, balance: r2(b[code] || 0) }));
}
function moneyMovements(db, { account, from, to }) {
  const w = ['a.money=1']; const p = [];
  if (account) { w.push('l.account_code=?'); p.push(account); }
  if (from) { w.push('e.date>=?'); p.push(from); } if (to) { w.push('e.date<=?'); p.push(to); }
  return db.all(`SELECT e.id entry_id, e.date, e.description, e.ref_type, e.ref_id, l.account_code, a.name account, l.debit, l.credit
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.code=l.account_code WHERE ${w.join(' AND ')} ORDER BY e.date, e.id`, ...p);
}

function receivables(db) {
  const S = require('./sales');
  return db.all("SELECT s.*, c.name customer, c.phone FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.status!='cancelado' OR EXISTS(SELECT 1 FROM sale_payments p WHERE p.sale_id=s.id AND p.status='activo') ORDER BY s.date")
    .map(s => S.enrich(db, s)).filter(s => Math.abs(s.balance) > 0.009);
}
function payables(db) {
  const bySupplier = db.all(`SELECT s.id, s.name,
      COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=s.id AND pay_status='credito' AND status='activa'),0)
    + COALESCE((SELECT SUM(amount) FROM expenses WHERE supplier_id=s.id AND pay_status='pendiente' AND status='activo'),0) debt,
      COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id AND status='activo'),0) paid FROM suppliers s`)
    .map(r => ({ ...r, balance: r2(r.debt - r.paid) })).filter(r => Math.abs(r.balance) > 0.009);
  const b = L.balances(db);
  return { suppliers: bySupplier, total_ledger: r2(-(b['2101'] || 0)) };
}

module.exports = { createExpense, capitalMove, createLoan, payLoan, transfer, annul, moneyBalances, moneyMovements, receivables, payables, ANNULLABLE };
