// Budget module helpers: constants, validation, month math, serialization and the recurring-bill engine.
import { httpError, isDate } from '../../util.js';

/** Icon keys the client knows how to render (client/src/modules/budget/icons.tsx mirrors this list). */
export const ICONS = [
  'shopping-cart', 'home', 'zap', 'car', 'baby', 'heart-pulse', 'utensils', 'ticket', 'shopping-bag', 'piggy-bank',
  'circle-dashed', 'briefcase', 'gift', 'plane', 'graduation-cap', 'dog', 'dumbbell', 'coffee', 'wifi', 'smartphone',
  'book', 'music', 'wrench', 'sparkles', 'banknote', 'shirt', 'gamepad', 'fuel', 'receipt', 'hand-coins',
];

export const DEFAULT_CATEGORIES = [
  { name: 'Groceries', icon: 'shopping-cart', color: '#30A46C', kind: 'expense' },
  { name: 'Housing', icon: 'home', color: '#5B5BD6', kind: 'expense' },
  { name: 'Utilities', icon: 'zap', color: '#FFB224', kind: 'expense' },
  { name: 'Transport', icon: 'car', color: '#0090FF', kind: 'expense' },
  { name: 'Kids', icon: 'baby', color: '#05A2C2', kind: 'expense' },
  { name: 'Health', icon: 'heart-pulse', color: '#E5484D', kind: 'expense' },
  { name: 'Dining', icon: 'utensils', color: '#D6409F', kind: 'expense' },
  { name: 'Entertainment', icon: 'ticket', color: '#8E4EC6', kind: 'expense' },
  { name: 'Shopping', icon: 'shopping-bag', color: '#12A594', kind: 'expense' },
  { name: 'Savings', icon: 'piggy-bank', color: '#978365', kind: 'expense' },
  { name: 'Other', icon: 'circle-dashed', color: '#8D90A0', kind: 'expense' },
  { name: 'Salary', icon: 'briefcase', color: '#30A46C', kind: 'income' },
  { name: 'Side income', icon: 'hand-coins', color: '#12A594', kind: 'income' },
  { name: 'Gifts & refunds', icon: 'gift', color: '#D6409F', kind: 'income' },
];

export const KINDS = ['expense', 'income'];
export const MAX_AMOUNT_CENTS = 100_000_000_00; // 100 million

export const canManage = (req) => req.role !== 'child';

/** Parse a money amount (number or numeric string, ≤ 2 decimals) into integer cents. */
export function toCents(value, { field = 'Amount', allowNegative = false, allowZero = false } = {}) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  else throw httpError(400, `${field} must be a number`);
  if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw httpError(400, `${field} can have at most 2 decimals`);
  if (!allowNegative && cents < 0) throw httpError(400, `${field} must be positive`);
  if (!allowZero && cents === 0) throw httpError(400, `${field} must be more than zero`);
  if (Math.abs(cents) > MAX_AMOUNT_CENTS) throw httpError(400, `${field} is too large`);
  return cents;
}

export const fromCents = (c) => (c == null ? null : Math.round(c) / 100);

// ---- dates -------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar date 'YYYY-MM-DD'. */
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthOf = (date) => date.slice(0, 7);
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const daysInMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export const monthStart = (month) => `${month}-01`;
export const monthEnd = (month) => `${month}-${pad(daysInMonth(month))}`;
/** Due date of a monthly bill in `month` (day clamped to the month's length, e.g. 31 → Feb 28). */
export const dueDate = (month, day) => `${month}-${pad(Math.min(day, daysInMonth(month)))}`;

export const MIN_DATE = '1970-01-01';
export const MAX_DATE = '2100-12-31';
export const inRange = (d) => d >= MIN_DATE && d <= MAX_DATE;

export function parseMonth(value, fallback = monthOf(dateKey())) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isMonth(value) || !inRange(`${value}-01`)) throw httpError(400, 'Month must look like YYYY-MM (1970–2100)');
  return value;
}


const upgraded = new WeakSet();
/** Add budget_meta columns to databases created before they existed (idempotent, once per db). */
export function upgradeMeta(db) {
  if (upgraded.has(db)) return;
  upgraded.add(db);
  const cols = db.prepare('PRAGMA table_info(budget_meta)').all().map((c) => c.name);
  if (!cols.includes('defaults_done')) {
    db.exec('ALTER TABLE budget_meta ADD COLUMN defaults_done INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE budget_meta SET defaults_done = 1'); // rows only existed once defaults were created
  }
  // Kids used to default to the warning orange; move untouched defaults to the new cyan.
  db.exec("UPDATE budget_categories SET color = '#05A2C2' WHERE kind = 'expense' AND name = 'Kids' AND icon = 'baby' AND upper(color) = '#F76B15'");
}

/** "Today" for a family (background jobs): the family's time zone via ctx.time. */
export function familyToday(ctx, familyId) {
  return ctx.time?.todayForFamily ? ctx.time.todayForFamily(familyId) : dateKey();
}

/**
 * "Today" for a request: an explicit client date (?today= / body.today, accepted when within
 * ~a day of now) or the user's local date from ctx.time (X-Timezone header).
 */
export function requestToday(ctx, req) {
  const candidate = req.query?.today ?? req.body?.today;
  if (typeof candidate === 'string' && isValidDate(candidate)) {
    const diff = Math.abs(Date.parse(`${candidate}T12:00:00Z`) - Date.now());
    if (diff <= 36 * 3600_000) return candidate;
  }
  return ctx.time?.today ? ctx.time.today(req) : dateKey();
}

export const isValidDate = (s) => isDate(s) && inRange(s);

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function money(cents, currency = 'USD') {
  const n = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// ---- serialization -----------------------------------------------------------------------

export const TX_SELECT = `
  SELECT t.*, c.name AS c_name, c.icon AS c_icon, c.color AS c_color, c.kind AS c_kind
  FROM budget_transactions t LEFT JOIN budget_categories c ON c.id = t.category_id`;

export function txOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    amount: fromCents(row.amount_cents),
    category_id: row.category_id,
    category: row.category_id ? { id: row.category_id, name: row.c_name, icon: row.c_icon, color: row.c_color, kind: row.c_kind } : null,
    description: row.description,
    date: row.date,
    paid_by: row.paid_by,
    receipt_url: row.receipt_url,
    notes: row.notes,
    recurring_id: row.recurring_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function categoryOut(row) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    kind: row.kind,
    monthly_limit: fromCents(row.limit_cents),
    sort: row.sort,
    created_at: row.created_at,
  };
}

// ---- default categories ------------------------------------------------------------------

/** Create the default categories the first time a family opens the budget (never again). */
export function ensureDefaults(db, familyId) {
  upgradeMeta(db);
  const done = db.prepare('SELECT defaults_done FROM budget_meta WHERE family_id = ?').get(familyId);
  if (done?.defaults_done) return false;
  db.exec('SAVEPOINT budget_defaults');
  try {
    db.prepare('INSERT INTO budget_meta (family_id, defaults_done) VALUES (?, 1) ON CONFLICT(family_id) DO UPDATE SET defaults_done = 1').run(familyId);
    const insert = db.prepare('INSERT INTO budget_categories (family_id, name, icon, color, kind, sort) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach((c, i) => insert.run(familyId, c.name, c.icon, c.color, c.kind, i * 10));
    db.exec('RELEASE budget_defaults');
  } catch (err) {
    db.exec('ROLLBACK TO budget_defaults');
    db.exec('RELEASE budget_defaults');
    throw err;
  }
  return true;
}

// ---- recurring bills ---------------------------------------------------------------------

/**
 * Status of a bill for `month`:
 *   paid | skipped | overdue (due date passed, nothing recorded) | due_today | upcoming | inactive
 */
export function billStatus(bill, month, run, today = dateKey()) {
  if (run) return run.status === 'paid' && run.transaction_id ? 'paid' : 'skipped';
  if (month < bill.start_month || (bill.end_month && month > bill.end_month)) return 'inactive';
  const due = dueDate(month, bill.day_of_month);
  if (due < today) return 'overdue';
  if (due === today) return 'due_today';
  return 'upcoming';
}

export function billOut(row, extra = {}) {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    amount: fromCents(row.amount_cents),
    category_id: row.category_id,
    category: row.category_id && row.c_name ? { id: row.category_id, name: row.c_name, icon: row.c_icon, color: row.c_color, kind: row.c_kind } : null,
    day_of_month: row.day_of_month,
    paid_by: row.paid_by,
    auto_create: !!row.auto_create,
    start_month: row.start_month,
    end_month: row.end_month,
    active: !!row.active,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    ...extra,
  };
}

export const BILL_SELECT = `
  SELECT b.*, c.name AS c_name, c.icon AS c_icon, c.color AS c_color, c.kind AS c_kind
  FROM budget_recurring b LEFT JOIN budget_categories c ON c.id = b.category_id`;

/**
 * Record a payment of `bill` for `month` (transaction + run row). Returns the transaction row id.
 * Caller wraps in a transaction.
 */
export function recordBillPayment(db, bill, month, { amountCents, date, userId, paidBy } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, date, paid_by, recurring_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    bill.family_id, bill.kind, amountCents ?? bill.amount_cents, bill.category_id, bill.description,
    date ?? dueDate(month, bill.day_of_month), paidBy === undefined ? bill.paid_by : paidBy, bill.id, userId ?? bill.created_by,
  );
  db.prepare(
    `INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id) VALUES (?, ?, ?, 'paid', ?)
     ON CONFLICT(recurring_id, month) DO UPDATE SET status = 'paid', transaction_id = excluded.transaction_id`,
  ).run(bill.id, bill.family_id, month, lastInsertRowid);
  return Number(lastInsertRowid);
}

/**
 * Auto-create transactions for "auto" bills whose due date has arrived (on/after the day the bill
 * was created, at most 12 months back) and that have no run yet for that month.
 * Returns the created transaction ids.
 */
export function generateDue(db, familyId, today = dateKey()) {
  const bills = db.prepare('SELECT * FROM budget_recurring WHERE family_id = ? AND active = 1 AND auto_create = 1').all(familyId);
  if (!bills.length) return [];
  const created = [];
  const current = monthOf(today);
  const earliest = addMonths(current, -12);
  const runs = new Set(
    db.prepare('SELECT recurring_id, month FROM budget_recurring_runs WHERE family_id = ? AND month >= ?')
      .all(familyId, earliest).map((r) => `${r.recurring_id}|${r.month}`),
  );
  db.exec('SAVEPOINT budget_gen');
  try {
    for (const bill of bills) {
      const since = (bill.generate_from || bill.created_at || '').slice(0, 10);
      let month = bill.start_month > earliest ? bill.start_month : earliest;
      for (; month <= current; month = addMonths(month, 1)) {
        if (bill.end_month && month > bill.end_month) break;
        const due = dueDate(month, bill.day_of_month);
        if (due > today || due < since) continue;
        if (runs.has(`${bill.id}|${month}`)) continue;
        created.push(recordBillPayment(db, bill, month, {}));
      }
    }
    db.exec('RELEASE budget_gen');
  } catch (err) {
    db.exec('ROLLBACK TO budget_gen');
    db.exec('RELEASE budget_gen');
    throw err;
  }
  return created;
}
