// Family budget — module "budget", mounted at /api/budget.
// Transactions (expense/income) with categories + monthly limits, recurring monthly bills,
// savings goals and kids' allowances. See docs/MODULE_SPECS.md ("budget").
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { cleanStr, firstName, httpError, isColor, toId } from '../util.js';
import {
  BILL_SELECT, ICONS, KINDS, TX_SELECT, addMonths, billOut, billStatus, canManage, categoryOut, dateKey, dueDate,
  ensureDefaults, familyToday, fromCents, generateDue, isValidDate, monthEnd, monthLabel, monthOf, monthStart, money, parseMonth,
  recordBillPayment, requestToday, toCents, txOut, upgradeMeta,
} from './budget/lib.js';

export { seed } from './budget/seed.js';

export const name = 'budget';

export const migrations = [
  `CREATE TABLE IF NOT EXISTS budget_meta (
     family_id INTEGER PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
     defaults_done INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE TABLE IF NOT EXISTS budget_categories (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     icon TEXT NOT NULL DEFAULT 'circle-dashed',
     color TEXT NOT NULL DEFAULT '#8D90A0',
     kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
     limit_cents INTEGER,
     sort INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_categories_family ON budget_categories(family_id)`,
  `CREATE TABLE IF NOT EXISTS budget_recurring (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
     description TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     category_id INTEGER REFERENCES budget_categories(id) ON DELETE SET NULL,
     day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
     paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     auto_create INTEGER NOT NULL DEFAULT 0,
     start_month TEXT NOT NULL,
     end_month TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     notes TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_recurring_family ON budget_recurring(family_id)`,
  `CREATE TABLE IF NOT EXISTS budget_transactions (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
     category_id INTEGER REFERENCES budget_categories(id) ON DELETE SET NULL,
     description TEXT,
     date TEXT NOT NULL,
     paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     receipt_url TEXT,
     notes TEXT,
     recurring_id INTEGER REFERENCES budget_recurring(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     deleted_at TEXT,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_tx_family_date ON budget_transactions(family_id, date)`,
  `CREATE TABLE IF NOT EXISTS budget_recurring_runs (
     recurring_id INTEGER NOT NULL REFERENCES budget_recurring(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     month TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('paid','skipped')),
     transaction_id INTEGER REFERENCES budget_transactions(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (recurring_id, month))`,
  `CREATE TABLE IF NOT EXISTS budget_recurring_reminders (
     recurring_id INTEGER NOT NULL REFERENCES budget_recurring(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     month TEXT NOT NULL,
     PRIMARY KEY (recurring_id, month))`,
  `CREATE TABLE IF NOT EXISTS budget_goals (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     emoji TEXT,
     color TEXT NOT NULL DEFAULT '#12A594',
     target_cents INTEGER NOT NULL,
     owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     target_date TEXT,
     completed_at TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE TABLE IF NOT EXISTS budget_goal_entries (
     id INTEGER PRIMARY KEY,
     goal_id INTEGER NOT NULL REFERENCES budget_goals(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     amount_cents INTEGER NOT NULL,
     note TEXT,
     source TEXT NOT NULL DEFAULT 'manual',
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_goal_entries_goal ON budget_goal_entries(goal_id)`,
  `CREATE TABLE IF NOT EXISTS budget_allowances (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     amount_cents INTEGER NOT NULL,
     frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly','monthly')),
     goal_id INTEGER REFERENCES budget_goals(id) ON DELETE SET NULL,
     last_paid_at TEXT,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     UNIQUE (family_id, member_id))`,
  `CREATE INDEX IF NOT EXISTS idx_budget_runs_tx ON budget_recurring_runs(transaction_id)`,
  `CREATE INDEX IF NOT EXISTS idx_budget_runs_family_month ON budget_recurring_runs(family_id, month)`,
  `CREATE INDEX IF NOT EXISTS idx_budget_goals_family ON budget_goals(family_id)`,
];

// --------------------------------------------------------------------------------------------

const EMOJI_MAX = 8;

function memberIds(db, familyId) {
  return db.prepare('SELECT user_id, role FROM memberships WHERE family_id = ?').all(familyId);
}
function assertMember(db, familyId, userId, field = 'Member') {
  const row = db.prepare('SELECT role FROM memberships WHERE family_id = ? AND user_id = ?').get(familyId, userId);
  if (!row) throw httpError(400, `${field} is not in this family`);
  return row;
}
const adultIds = (db, familyId) => memberIds(db, familyId).filter((m) => m.role !== 'child').map((m) => m.user_id);
const allIds = (db, familyId) => memberIds(db, familyId).map((m) => m.user_id);

function requireManager(req, what = 'do that') {
  if (!canManage(req)) throw httpError(403, `Ask a parent to ${what}`);
}

function getCategory(db, familyId, id) {
  const row = db.prepare('SELECT * FROM budget_categories WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!row) throw httpError(404, 'Category not found');
  return row;
}

function loadTx(db, familyId, id) {
  const row = db.prepare(`${TX_SELECT} WHERE t.id = ? AND t.family_id = ? AND t.deleted_at IS NULL`).get(id, familyId);
  if (!row) throw httpError(404, 'Transaction not found');
  return row;
}

function loadBill(db, familyId, id) {
  const row = db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.family_id = ?`).get(id, familyId);
  if (!row) throw httpError(404, 'Bill not found');
  return row;
}

function loadGoal(db, familyId, id) {
  const row = db.prepare('SELECT * FROM budget_goals WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!row) throw httpError(404, 'Goal not found');
  return row;
}

/** Entry totals per goal: on goal rows from GOALS_SELECT, or `goalStats(db, id)` for a single one. */
const GOAL_STATS = 'COALESCE(SUM(e.amount_cents), 0) AS saved_cents, COUNT(e.id) AS entry_count, MAX(e.created_at) AS last_entry_at';
const GOALS_SELECT = `SELECT g.*, ${GOAL_STATS} FROM budget_goals g LEFT JOIN budget_goal_entries e ON e.goal_id = g.id`;
const goalStats = (db, goalId) => db.prepare(`SELECT ${GOAL_STATS} FROM budget_goal_entries e WHERE e.goal_id = ?`).get(goalId);
const goalSaved = (db, goalId) => goalStats(db, goalId).saved_cents;

function goalOut(db, row, { entries = false } = {}) {
  const stats = row.entry_count === undefined ? goalStats(db, row.id) : row;
  const out = {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    target: fromCents(row.target_cents),
    saved: fromCents(stats.saved_cents),
    owner_id: row.owner_id,
    target_date: row.target_date,
    completed_at: row.completed_at,
    created_by: row.created_by,
    created_at: row.created_at,
    entry_count: stats.entry_count,
    last_entry_at: stats.last_entry_at,
  };
  if (entries) {
    out.entries = db
      .prepare('SELECT * FROM budget_goal_entries WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
      .all(row.id)
      .map((e) => ({ id: e.id, amount: fromCents(e.amount_cents), note: e.note, source: e.source, user_id: e.user_id, created_at: e.created_at }));
  }
  return out;
}

/** Child may only touch goals they own or created. */
function canEditGoal(req, goal) {
  return canManage(req) || goal.owner_id === req.user.id || goal.created_by === req.user.id;
}

function spentIn(db, familyId, categoryId, month) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM budget_transactions
       WHERE family_id = ? AND category_id = ? AND kind = 'expense' AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    )
    .get(familyId, categoryId, monthStart(month), monthEnd(month)).s;
}

/** Notify grown-ups when a category crosses its monthly limit. */
function checkOverBudget(ctx, req, categoryId, month, beforeCents) {
  if (!categoryId) return;
  const cat = ctx.db.prepare('SELECT * FROM budget_categories WHERE id = ?').get(categoryId);
  if (!cat || cat.kind !== 'expense' || !cat.limit_cents) return;
  const after = spentIn(ctx.db, req.family.id, categoryId, month);
  if (beforeCents <= cat.limit_cents && after > cat.limit_cents) {
    ctx.notify({
      familyId: req.family.id,
      userIds: adultIds(ctx.db, req.family.id),
      module: 'budget',
      title: `${cat.name} is over budget`,
      body: `${money(after, req.family.currency)} spent of ${money(cat.limit_cents, req.family.currency)} in ${monthLabel(month)}`,
      link: `/budget?month=${month}`,
      excludeUserId: req.user.id,
    });
    ctx.broadcast(req.family.id, 'budget.category.over', { category_id: categoryId, month });
  }
}

function parseTxBody(db, req, body, existing, today = dateKey()) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!existing || has('kind')) {
    const kind = body.kind ?? 'expense';
    if (!KINDS.includes(kind)) throw httpError(400, 'Type must be expense or income');
    if (kind === 'income' && !canManage(req)) throw httpError(403, 'Ask a parent to record income');
    out.kind = kind;
  }
  if (!existing || has('amount')) {
    if (body.amount === undefined || body.amount === null || body.amount === '') throw httpError(400, 'Amount is required');
    out.amount_cents = toCents(body.amount);
  }
  if (!existing || has('description')) out.description = cleanStr(body.description, { field: 'Description', max: 140 });
  if (!existing || has('notes')) out.notes = cleanStr(body.notes, { field: 'Notes', max: 1000 });
  if (!existing || has('date')) {
    const date = body.date ?? today;
    if (!isValidDate(date)) throw httpError(400, 'Date must be a valid YYYY-MM-DD date between 1970 and 2100');
    out.date = date;
  }
  const kind = out.kind ?? existing?.kind;
  if (!existing || has('category_id') || has('kind')) {
    const raw = has('category_id') ? body.category_id : existing?.category_id;
    if (raw === null || raw === undefined || raw === '') out.category_id = null;
    else {
      const cat = getCategory(db, req.family.id, toId(raw, 'category'));
      if (cat.kind !== kind) {
        if (has('category_id')) throw httpError(400, `${cat.name} is an ${cat.kind} category`);
        out.category_id = null; // kind changed: drop the now-mismatched category
      } else out.category_id = cat.id;
    }
  }
  if (!existing || has('paid_by')) {
    const raw = has('paid_by') ? body.paid_by : req.user.id;
    if (raw === null || raw === '') out.paid_by = null;
    else {
      const id = toId(raw, 'member');
      assertMember(db, req.family.id, id, 'Paid by');
      if (!canManage(req) && id !== req.user.id) throw httpError(403, 'Kids can only record their own spending');
      out.paid_by = id;
    }
  }
  return out;
}

function canEditTx(req, row) {
  return canManage(req) || row.created_by === req.user.id;
}

/** Month overview: totals, categories with spent/limit, 6-month trend, per-member, pace. */
function buildSummary(db, familyId, month) {
  const start = monthStart(month);
  const end = monthEnd(month);
  const catRows = db.prepare('SELECT * FROM budget_categories WHERE family_id = ? ORDER BY sort, id').all(familyId);
  const catAgg = db
    .prepare(
      `SELECT category_id, kind, SUM(amount_cents) AS s, COUNT(*) AS n FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ? GROUP BY category_id, kind`,
    )
    .all(familyId, start, end);
  const totals = { income: 0, spent: 0 };
  let count = 0;
  for (const r of catAgg) {
    if (r.kind === 'income') totals.income += r.s;
    else totals.spent += r.s;
    count += r.n;
  }
  const agg = new Map(catAgg.map((r) => [r.category_id ?? 0, r]));
  const uncategorized = catAgg.filter((r) => r.category_id === null);

  const categories = catRows.map((c) => {
    const a = agg.get(c.id);
    return { ...categoryOut(c), total: fromCents(a?.s ?? 0), count: a?.n ?? 0 };
  });

  const firstTrend = addMonths(month, -5);
  const trendRows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS m, kind, SUM(amount_cents) AS s FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ? GROUP BY m, kind`,
    )
    .all(familyId, monthStart(firstTrend), end);
  const trend = [];
  for (let i = 0; i < 6; i++) {
    const m = addMonths(firstTrend, i);
    trend.push({
      month: m,
      income: fromCents(trendRows.find((r) => r.m === m && r.kind === 'income')?.s ?? 0),
      spent: fromCents(trendRows.find((r) => r.m === m && r.kind === 'expense')?.s ?? 0),
    });
  }
  const prevMonth = addMonths(month, -1);
  const prevSpent = trendRows.find((r) => r.m === prevMonth && r.kind === 'expense')?.s ?? 0;

  const byMember = db
    .prepare(
      `SELECT paid_by AS user_id, SUM(amount_cents) AS s, COUNT(*) AS n FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND kind = 'expense' AND date BETWEEN ? AND ?
       GROUP BY paid_by ORDER BY s DESC`,
    )
    .all(familyId, start, end)
    .map((r) => ({ user_id: r.user_id, spent: fromCents(r.s), count: r.n }));

  // Cumulative daily spending (for the "pace" sparkline).
  const daily = db
    .prepare(
      `SELECT date, SUM(amount_cents) AS s FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND kind = 'expense' AND date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(familyId, start, end)
    .map((r) => ({ date: r.date, spent: fromCents(r.s) }));

  const totalLimit = catRows.filter((c) => c.kind === 'expense' && c.limit_cents).reduce((s, c) => s + c.limit_cents, 0);

  return {
    month,
    totals: {
      income: fromCents(totals.income),
      spent: fromCents(totals.spent),
      balance: fromCents(totals.income - totals.spent),
      prev_spent: fromCents(prevSpent),
      budgeted: fromCents(totalLimit),
      count,
    },
    categories,
    uncategorized: {
      expense: fromCents(uncategorized.find((u) => u.kind === 'expense')?.s ?? 0),
      income: fromCents(uncategorized.find((u) => u.kind === 'income')?.s ?? 0),
    },
    trend,
    by_member: byMember,
    daily,
  };
}

function billsForMonth(db, familyId, month, today = dateKey()) {
  const rows = db.prepare(`${BILL_SELECT} WHERE b.family_id = ? ORDER BY b.day_of_month, b.id`).all(familyId);
  const runs = new Map(
    db
      .prepare(
        `SELECT r.*, t.amount_cents AS t_amount, t.date AS t_date, t.paid_by AS t_paid_by FROM budget_recurring_runs r
         LEFT JOIN budget_transactions t ON t.id = r.transaction_id AND t.deleted_at IS NULL
         WHERE r.family_id = ? AND r.month = ?`,
      )
      .all(familyId, month)
      .map((r) => [r.recurring_id, r]),
  );
  const out = [];
  for (const b of rows) {
    let run = runs.get(b.id);
    // A paid run whose transaction was deleted counts as not recorded (the date decides the status).
    if (run && run.status === 'paid' && !run.t_amount) run = undefined;
    if (!b.active && !run) continue;
    const status = billStatus(b, month, run, today);
    if (status === 'inactive') continue;
    out.push(
      billOut(b, {
        month,
        due_date: dueDate(month, b.day_of_month),
        status,
        transaction_id: run?.transaction_id ?? null,
        paid_amount: run?.t_amount ? fromCents(run.t_amount) : null,
        paid_date: run?.t_date ?? null,
      }),
    );
  }
  return out;
}

function parseBillBody(db, req, body, existing) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const out = {};
  if (!existing || has('kind')) {
    const kind = body.kind ?? 'expense';
    if (!KINDS.includes(kind)) throw httpError(400, 'Type must be expense or income');
    out.kind = kind;
  }
  if (!existing || has('description')) out.description = cleanStr(body.description, { field: 'Name', required: true, max: 120 });
  if (!existing || has('amount')) {
    if (body.amount === undefined || body.amount === null || body.amount === '') throw httpError(400, 'Amount is required');
    out.amount_cents = toCents(body.amount);
  }
  if (!existing || has('day_of_month')) {
    const d = Number(body.day_of_month ?? 1);
    if (!Number.isInteger(d) || d < 1 || d > 31) throw httpError(400, 'Day of month must be between 1 and 31');
    out.day_of_month = d;
  }
  const kind = out.kind ?? existing?.kind;
  if (!existing || has('category_id') || has('kind')) {
    const raw = has('category_id') ? body.category_id : existing?.category_id;
    if (raw === null || raw === undefined || raw === '') out.category_id = null;
    else {
      const cat = getCategory(db, req.family.id, toId(raw, 'category'));
      if (cat.kind !== kind) {
        if (has('category_id')) throw httpError(400, `${cat.name} is an ${cat.kind} category`);
        out.category_id = null;
      } else out.category_id = cat.id;
    }
  }
  if (!existing || has('paid_by')) {
    const raw = body.paid_by;
    if (raw === undefined || raw === null || raw === '') out.paid_by = null;
    else {
      const id = toId(raw, 'member');
      assertMember(db, req.family.id, id, 'Paid by');
      out.paid_by = id;
    }
  }
  if (!existing || has('auto_create')) out.auto_create = body.auto_create ? 1 : 0;
  if (!existing || has('start_month')) out.start_month = parseMonth(body.start_month);
  if (!existing || has('end_month')) out.end_month = body.end_month ? parseMonth(body.end_month) : null;
  if (has('active')) out.active = body.active ? 1 : 0;
  if (!existing || has('notes')) out.notes = cleanStr(body.notes, { field: 'Notes', max: 500 });
  const start = out.start_month ?? existing?.start_month;
  const endM = out.end_month !== undefined ? out.end_month : existing?.end_month;
  if (endM && start && endM < start) throw httpError(400, 'End month must be after the start month');
  return out;
}

function updateRow(db, table, id, fields, extraSql = '') {
  const keys = Object.keys(fields);
  if (!keys.length && !extraSql) return;
  const sets = keys.map((k) => `${k} = ?`);
  if (extraSql) sets.push(extraSql);
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

function allowanceOut(row) {
  return {
    id: row.id,
    member_id: row.member_id,
    amount: fromCents(row.amount_cents),
    frequency: row.frequency,
    goal_id: row.goal_id,
    last_paid_at: row.last_paid_at,
    created_at: row.created_at,
  };
}

/** Periodic housekeeping: auto bills, due-today reminders, purge of soft-deleted transactions. */
export function sweep(ctx, todayOverride = null) {
  const { db } = ctx;
  const families = db.prepare('SELECT DISTINCT family_id FROM budget_recurring WHERE active = 1').all().map((r) => r.family_id);
  for (const familyId of families) {
    // Each family's own calendar day (from the time zone its members' browsers report).
    const today = todayOverride ?? familyToday(ctx, familyId);
    const created = generateDue(db, familyId, today, ctx.time.familyTz(familyId));
    if (created.length) ctx.broadcast(familyId, 'budget.transaction.created', { ids: created, auto: true });
    // Reminders for manual bills due today.
    const month = monthOf(today);
    const family = db.prepare('SELECT currency FROM families WHERE id = ?').get(familyId);
    for (const bill of billsForMonth(db, familyId, month, today)) {
      if (bill.auto_create || bill.status !== 'due_today') continue;
      const { changes } = db
        .prepare('INSERT OR IGNORE INTO budget_recurring_reminders (recurring_id, family_id, month) VALUES (?, ?, ?)')
        .run(bill.id, familyId, month);
      if (!changes) continue;
      ctx.notify({
        familyId,
        userIds: bill.paid_by ? [bill.paid_by] : adultIds(db, familyId),
        module: 'budget',
        title: `${bill.description} is due today`,
        body: `${money(Math.round(bill.amount * 100), family?.currency)} — mark it paid once it's done`,
        link: `/budget/bills?month=${month}`,
      });
    }
  }
  // Soft-deleted transactions can be restored for a while (undo), then they're removed for good.
  const cutoff = new Date(Date.now() - 2 * 864e5).toISOString();
  for (const row of db.prepare('SELECT id, receipt_url FROM budget_transactions WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff)) {
    if (row.receipt_url) ctx.removeFile(row.receipt_url);
    db.prepare('DELETE FROM budget_transactions WHERE id = ?').run(row.id);
  }
}

// --------------------------------------------------------------------------------------------

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const r = Router();
  upgradeMeta(db);

  // Background housekeeping (unref'd so it never keeps a process alive).
  const runSweep = () => {
    try {
      sweep(ctx);
    } catch (err) {
      if (/not open|closed/i.test(err.message)) clearInterval(timer);
      else console.error('[budget] sweep failed:', err.message);
    }
  };
  const timer = setInterval(runSweep, 10 * 60_000);
  timer.unref?.();
  setTimeout(runSweep, 3000).unref?.();

  /** Lazily create defaults + auto bills whenever someone opens the budget. */
  const prepare = (req) => {
    const familyId = req.family.id;
    ensureDefaults(db, familyId);
    const today = requestToday(ctx, req);
    const created = generateDue(db, familyId, today, ctx.time.tz(req));
    if (created.length) ctx.broadcast(familyId, 'budget.transaction.created', { ids: created, auto: true });
    return today;
  };

  const emit = (req, type, payload) => ctx.broadcast(req.family.id, `budget.${type}`, payload);

  // ---- overview ------------------------------------------------------------------------------

  r.get('/', (req, res) => {
    prepare(req);
    res.json({ ok: true, currency: req.family.currency });
  });

  r.get('/summary', (req, res) => {
    const today = prepare(req);
    const month = parseMonth(req.query.month, monthOf(today));
    const summary = buildSummary(db, req.family.id, month);
    const bills = billsForMonth(db, req.family.id, month, today);
    res.json({
      ...summary,
      currency: req.family.currency,
      today,
      bills: {
        total: bills.length,
        paid: bills.filter((b) => b.status === 'paid').length,
        due: bills.filter((b) => ['overdue', 'due_today'].includes(b.status)).length,
        remaining: fromCents(
          bills.filter((b) => b.kind === 'expense' && !['paid', 'skipped'].includes(b.status)).reduce((s, b) => s + Math.round(b.amount * 100), 0),
        ),
      },
    });
  });

  /** Nav badge: bills that need attention this month (grown-ups only). */
  r.get('/badge', (req, res) => {
    if (!canManage(req)) return res.json({ bills_due: 0 });
    ensureDefaults(db, req.family.id);
    const today = requestToday(ctx, req);
    const bills = billsForMonth(db, req.family.id, monthOf(today), today);
    res.json({ bills_due: bills.filter((b) => ['overdue', 'due_today'].includes(b.status)).length });
  });

  // ---- categories ------------------------------------------------------------------------

  r.get('/categories', (req, res) => {
    prepare(req);
    res.json(db.prepare('SELECT * FROM budget_categories WHERE family_id = ? ORDER BY kind DESC, sort, id').all(req.family.id).map(categoryOut));
  });

  const parseCategory = (req, body, existing) => {
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const out = {};
    if (!existing || has('name')) out.name = cleanStr(body.name, { field: 'Name', required: true, max: 40 });
    if (!existing || has('icon')) {
      const icon = body.icon ?? 'circle-dashed';
      if (!ICONS.includes(icon)) throw httpError(400, 'Unknown icon');
      out.icon = icon;
    }
    if (!existing || has('color')) {
      const color = body.color ?? '#8D90A0';
      if (!isColor(color)) throw httpError(400, 'Color must be a hex color like #30A46C');
      out.color = color.toUpperCase();
    }
    if (!existing) {
      const kind = body.kind ?? 'expense';
      if (!KINDS.includes(kind)) throw httpError(400, 'Type must be expense or income');
      out.kind = kind;
    } else if (has('kind') && body.kind !== existing.kind) {
      throw httpError(400, "A category's type can't be changed");
    }
    if (!existing || has('monthly_limit')) {
      const v = body.monthly_limit;
      out.limit_cents = v === undefined || v === null || v === '' || v === 0 ? null : toCents(v, { field: 'Monthly limit' });
      if (out.limit_cents && (out.kind ?? existing?.kind) === 'income') throw httpError(400, 'Only expense categories can have a limit');
    }
    const nm = out.name ?? existing?.name;
    const kind = out.kind ?? existing?.kind;
    const dupe = db
      .prepare('SELECT id FROM budget_categories WHERE family_id = ? AND kind = ? AND lower(name) = lower(?) AND id != ?')
      .get(req.family.id, kind, nm, existing?.id ?? 0);
    if (dupe) throw httpError(409, `There's already a category called ${nm}`);
    return out;
  };

  r.post('/categories', (req, res) => {
    requireManager(req, 'add categories');
    ensureDefaults(db, req.family.id);
    const f = parseCategory(req, req.body ?? {});
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM budget_categories WHERE family_id = ?').get(req.family.id).s;
    const { lastInsertRowid } = db
      .prepare('INSERT INTO budget_categories (family_id, name, icon, color, kind, limit_cents, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.family.id, f.name, f.icon, f.color, f.kind, f.limit_cents, sort);
    const row = categoryOut(getCategory(db, req.family.id, Number(lastInsertRowid)));
    emit(req, 'category.created', row);
    res.status(201).json(row);
  });

  r.patch('/categories/:id', (req, res) => {
    requireManager(req, 'change categories');
    const existing = getCategory(db, req.family.id, toId(req.params.id));
    const f = parseCategory(req, req.body ?? {}, existing);
    updateRow(db, 'budget_categories', existing.id, f);
    const row = categoryOut(getCategory(db, req.family.id, existing.id));
    emit(req, 'category.updated', row);
    res.json(row);
  });

  r.delete('/categories/:id', (req, res) => {
    requireManager(req, 'delete categories');
    const existing = getCategory(db, req.family.id, toId(req.params.id));
    const moveTo = req.body?.move_to ?? req.query.move_to;
    ctx.tx(db, () => {
      if (moveTo) {
        const target = getCategory(db, req.family.id, toId(moveTo, 'category'));
        if (target.id === existing.id) throw httpError(400, 'Pick a different category');
        if (target.kind !== existing.kind) throw httpError(400, `Move to another ${existing.kind} category`);
        db.prepare('UPDATE budget_transactions SET category_id = ? WHERE category_id = ? AND family_id = ?').run(target.id, existing.id, req.family.id);
        db.prepare('UPDATE budget_recurring SET category_id = ? WHERE category_id = ? AND family_id = ?').run(target.id, existing.id, req.family.id);
      }
      db.prepare('DELETE FROM budget_categories WHERE id = ?').run(existing.id);
    });
    emit(req, 'category.deleted', { id: existing.id });
    res.json({ ok: true });
  });

  // ---- transactions ------------------------------------------------------------------------

  r.get('/transactions', (req, res) => {
    prepare(req);
    const where = ['t.family_id = ?', 't.deleted_at IS NULL'];
    const args = [req.family.id];
    const q = cleanStr(req.query.q, { field: 'Search', max: 100 });
    const month = req.query.month ? parseMonth(req.query.month) : null;
    if (month && !(q && req.query.all === '1')) {
      where.push('t.date BETWEEN ? AND ?');
      args.push(monthStart(month), monthEnd(month));
    }
    if (req.query.kind) {
      if (!KINDS.includes(req.query.kind)) throw httpError(400, 'Type must be expense or income');
      where.push('t.kind = ?');
      args.push(req.query.kind);
    }
    if (req.query.category_id) {
      if (req.query.category_id === 'none') where.push('t.category_id IS NULL');
      else {
        where.push('t.category_id = ?');
        args.push(toId(req.query.category_id, 'category'));
      }
    }
    if (req.query.paid_by) {
      where.push('t.paid_by = ?');
      args.push(toId(req.query.paid_by, 'member'));
    }
    if (req.query.recurring_id) {
      where.push('t.recurring_id = ?');
      args.push(toId(req.query.recurring_id, 'bill'));
    }
    if (q) {
      where.push("(t.description LIKE '%' || ? || '%' OR t.notes LIKE '%' || ? || '%' OR c.name LIKE '%' || ? || '%')");
      args.push(q, q, q);
    }
    // Keyset pagination: ?cursor=<date>~<id> continues after that row. With ?page=1 the response is
    // { items, next_cursor }; without it, a plain array (first `limit` rows).
    if (req.query.cursor) {
      const m = /^(\d{4}-\d{2}-\d{2})~(\d+)$/.exec(String(req.query.cursor));
      if (!m) throw httpError(400, 'Invalid cursor');
      where.push('(t.date < ? OR (t.date = ? AND t.id < ?))');
      args.push(m[1], m[1], Number(m[2]));
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = db.prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(txOut);
    if (req.query.page === '1') {
      const last = items[items.length - 1];
      return res.json({ items, next_cursor: more && last ? `${last.date}~${last.id}` : null });
    }
    res.json(items);
  });

  r.get('/transactions/:id', (req, res) => {
    res.json(txOut(loadTx(db, req.family.id, toId(req.params.id))));
  });

  r.post('/transactions', (req, res) => {
    ensureDefaults(db, req.family.id);
    const f = parseTxBody(db, req, req.body ?? {}, null, requestToday(ctx, req));
    const month = monthOf(f.date);
    const before = f.category_id && f.kind === 'expense' ? spentIn(db, req.family.id, f.category_id, month) : 0;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, date, paid_by, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.family.id, f.kind, f.amount_cents, f.category_id, f.description, f.date, f.paid_by, f.notes, req.user.id);
    const row = txOut(loadTx(db, req.family.id, Number(lastInsertRowid)));
    emit(req, 'transaction.created', row);
    const label = row.description || row.category?.name || (row.kind === 'income' ? 'Income' : 'Expense');
    ctx.logActivity({
      familyId: req.family.id,
      userId: req.user.id,
      module: 'budget',
      verb: row.kind === 'income' ? 'income' : 'expense',
      entityId: row.id,
      summary: `${row.kind === 'income' ? 'added income' : 'added an expense'}: ${label} · ${money(f.amount_cents, req.family.currency)}`,
      link: `/budget/transactions?month=${month}&tx=${row.id}`,
    });
    checkOverBudget(ctx, req, f.category_id, month, before);
    res.status(201).json(row);
  });

  r.patch('/transactions/:id', (req, res) => {
    const existing = loadTx(db, req.family.id, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only edit transactions you added');
    const f = parseTxBody(db, req, req.body ?? {}, existing, requestToday(ctx, req));
    const next = { ...existing, ...f };
    const month = monthOf(next.date);
    const before = next.category_id && next.kind === 'expense'
      ? spentIn(db, req.family.id, next.category_id, month) - (existing.category_id === next.category_id && monthOf(existing.date) === month && existing.kind === 'expense' ? existing.amount_cents : 0)
      : 0;
    updateRow(db, 'budget_transactions', existing.id, f, `updated_at = ${ISO_NOW}`);
    const row = txOut(loadTx(db, req.family.id, existing.id));
    emit(req, 'transaction.updated', row);
    checkOverBudget(ctx, req, next.category_id, month, before);
    res.json(row);
  });

  r.delete('/transactions/:id', (req, res) => {
    const existing = loadTx(db, req.family.id, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only delete transactions you added');
    db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE id = ?`).run(existing.id);
    emit(req, 'transaction.deleted', { id: existing.id });
    res.json({ ok: true, id: existing.id });
  });

  /** Undo a delete (soft-deleted rows are kept for 2 days). */
  r.post('/transactions/:id/restore', (req, res) => {
    const id = toId(req.params.id);
    const row = db.prepare('SELECT * FROM budget_transactions WHERE id = ? AND family_id = ? AND deleted_at IS NOT NULL').get(id, req.family.id);
    if (!row) throw httpError(404, 'Transaction not found');
    if (!canEditTx(req, row)) throw httpError(403, 'You can only restore transactions you added');
    if (row.recurring_id) {
      // A bill payment can only come back while its month still points at it (not re-paid, skipped or reset).
      const linked = db.prepare('SELECT 1 FROM budget_recurring_runs WHERE recurring_id = ? AND transaction_id = ?').get(row.recurring_id, id);
      if (!linked) throw httpError(409, 'That bill has been paid or skipped again since — this payment can’t be restored');
    }
    db.prepare('UPDATE budget_transactions SET deleted_at = NULL WHERE id = ?').run(id);
    const out = txOut(loadTx(db, req.family.id, id));
    emit(req, 'transaction.created', out);
    res.json(out);
  });

  r.post('/transactions/:id/receipt', ctx.upload.single('file'), (req, res) => {
    const existing = loadTx(db, req.family.id, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only change transactions you added');
    if (!req.file) throw httpError(400, 'Choose a photo of the receipt');
    if (!/^image\//.test(req.file.mimetype) && req.file.mimetype !== 'application/pdf') throw httpError(400, 'Receipts must be an image or a PDF');
    if (existing.receipt_url) ctx.removeFile(existing.receipt_url);
    db.prepare(`UPDATE budget_transactions SET receipt_url = ?, updated_at = ${ISO_NOW} WHERE id = ?`).run(req.file.url, existing.id);
    const row = txOut(loadTx(db, req.family.id, existing.id));
    emit(req, 'transaction.updated', row);
    res.json(row);
  });

  r.delete('/transactions/:id/receipt', (req, res) => {
    const existing = loadTx(db, req.family.id, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only change transactions you added');
    if (existing.receipt_url) ctx.removeFile(existing.receipt_url);
    db.prepare(`UPDATE budget_transactions SET receipt_url = NULL, updated_at = ${ISO_NOW} WHERE id = ?`).run(existing.id);
    const row = txOut(loadTx(db, req.family.id, existing.id));
    emit(req, 'transaction.updated', row);
    res.json(row);
  });

  // ---- recurring bills ---------------------------------------------------------------------

  r.get('/recurring', (req, res) => {
    const today = prepare(req);
    const month = parseMonth(req.query.month, monthOf(today));
    res.json(billsForMonth(db, req.family.id, month, today));
  });

  const billForMonth = (req, id, month, today = requestToday(ctx, req)) =>
    billsForMonth(db, req.family.id, month, today).find((b) => b.id === id) ?? billOut(loadBill(db, req.family.id, id));

  r.post('/recurring', (req, res) => {
    requireManager(req, 'add bills');
    ensureDefaults(db, req.family.id);
    const f = parseBillBody(db, req, req.body ?? {});
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO budget_recurring (family_id, kind, description, amount_cents, category_id, day_of_month, paid_by, auto_create, start_month, end_month, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.family.id, f.kind, f.description, f.amount_cents, f.category_id, f.day_of_month, f.paid_by, f.auto_create, f.start_month, f.end_month, f.notes, req.user.id);
    const id = Number(lastInsertRowid);
    const today = requestToday(ctx, req);
    const created = generateDue(db, req.family.id, today, ctx.time.tz(req));
    const bill = billForMonth(req, id, monthOf(today), today);
    emit(req, 'bill.created', bill);
    if (created.length) emit(req, 'transaction.created', { ids: created, auto: true });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'bill', entityId: id,
      summary: `added a monthly ${f.kind === 'income' ? 'income' : 'bill'}: ${f.description} · ${money(f.amount_cents, req.family.currency)}`,
      link: '/budget/bills',
    });
    res.status(201).json(bill);
  });

  r.patch('/recurring/:id', (req, res) => {
    requireManager(req, 'change bills');
    const existing = loadBill(db, req.family.id, toId(req.params.id));
    const f = parseBillBody(db, req, req.body ?? {}, existing);
    updateRow(db, 'budget_recurring', existing.id, f);
    const today = requestToday(ctx, req);
    generateDue(db, req.family.id, today, ctx.time.tz(req));
    const bill = billForMonth(req, existing.id, parseMonth(req.query.month ?? req.body?.month, monthOf(today)), today);
    emit(req, 'bill.updated', bill);
    res.json(bill);
  });

  r.delete('/recurring/:id', (req, res) => {
    requireManager(req, 'delete bills');
    const existing = loadBill(db, req.family.id, toId(req.params.id));
    // Past payments stay in the transaction history (recurring_id is set to NULL by the FK).
    db.prepare('DELETE FROM budget_recurring WHERE id = ?').run(existing.id);
    emit(req, 'bill.deleted', { id: existing.id });
    res.json({ ok: true });
  });

  r.post('/recurring/:id/pay', (req, res) => {
    requireManager(req, 'mark bills paid');
    const bill = loadBill(db, req.family.id, toId(req.params.id));
    const body = req.body ?? {};
    const today = requestToday(ctx, req);
    const month = parseMonth(body.month, monthOf(today));
    const current = billsForMonth(db, req.family.id, month, today).find((b) => b.id === bill.id);
    if (!current) throw httpError(400, `${bill.description} isn't scheduled for ${monthLabel(month)}`);
    if (current.status === 'paid') throw httpError(409, `${bill.description} is already paid for ${monthLabel(month)}`);
    const amountCents = body.amount !== undefined && body.amount !== null && body.amount !== '' ? toCents(body.amount) : bill.amount_cents;
    const date = body.date ?? (current.due_date <= today ? current.due_date : today);
    if (!isValidDate(date)) throw httpError(400, 'Date must be a valid YYYY-MM-DD date between 1970 and 2100');
    let paidBy = bill.paid_by ?? req.user.id;
    if (body.paid_by !== undefined && body.paid_by !== null && body.paid_by !== '') {
      paidBy = toId(body.paid_by, 'member');
      assertMember(db, req.family.id, paidBy, 'Paid by');
    }
    const before = bill.category_id && bill.kind === 'expense' ? spentIn(db, req.family.id, bill.category_id, monthOf(date)) : 0;
    const txId = ctx.tx(db, () => {
      if (current.transaction_id) db.prepare('UPDATE budget_recurring_runs SET transaction_id = NULL WHERE recurring_id = ? AND month = ?').run(bill.id, month);
      return recordBillPayment(db, bill, month, { amountCents, date, userId: req.user.id, paidBy });
    });
    const out = billForMonth(req, bill.id, month);
    emit(req, 'bill.paid', out);
    emit(req, 'transaction.created', txOut(loadTx(db, req.family.id, txId)));
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'paid', entityId: bill.id,
      summary: `${bill.kind === 'income' ? 'recorded' : 'paid'} ${bill.description} · ${money(amountCents, req.family.currency)}`,
      link: `/budget/bills?month=${month}`,
    });
    checkOverBudget(ctx, req, bill.category_id, monthOf(date), before);
    res.json(out);
  });

  r.post('/recurring/:id/skip', (req, res) => {
    requireManager(req, 'skip bills');
    const bill = loadBill(db, req.family.id, toId(req.params.id));
    const month = parseMonth(req.body?.month, monthOf(requestToday(ctx, req)));
    ctx.tx(db, () => {
      const run = db.prepare('SELECT * FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').get(bill.id, month);
      if (run?.transaction_id) db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE id = ? AND deleted_at IS NULL`).run(run.transaction_id);
      db.prepare(
        `INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id) VALUES (?, ?, ?, 'skipped', NULL)
         ON CONFLICT(recurring_id, month) DO UPDATE SET status = 'skipped', transaction_id = NULL`,
      ).run(bill.id, req.family.id, month);
    });
    const out = billForMonth(req, bill.id, month);
    emit(req, 'bill.updated', out);
    emit(req, 'transaction.deleted', { recurring_id: bill.id });
    res.json(out);
  });

  /** Undo "paid"/"skipped" for a month: removes the payment transaction and the run. */
  r.delete('/recurring/:id/runs/:month', (req, res) => {
    requireManager(req, 'change bills');
    const bill = loadBill(db, req.family.id, toId(req.params.id));
    const month = parseMonth(req.params.month);
    ctx.tx(db, () => {
      const run = db.prepare('SELECT * FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').get(bill.id, month);
      if (!run) throw httpError(404, 'Nothing recorded for that month');
      if (run.transaction_id) db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE id = ? AND deleted_at IS NULL`).run(run.transaction_id);
      db.prepare('DELETE FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').run(bill.id, month);
      // An auto bill already due would be re-created by the next sweep, so undoing its payment means "skipped".
      if (bill.auto_create && run.status === 'paid' && dueDate(month, bill.day_of_month) <= requestToday(ctx, req)) {
        db.prepare(`INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status) VALUES (?, ?, ?, 'skipped')`).run(bill.id, req.family.id, month);
      }
    });
    const out = billForMonth(req, bill.id, month);
    emit(req, 'bill.updated', out);
    emit(req, 'transaction.deleted', { recurring_id: bill.id });
    res.json(out);
  });

  // ---- savings goals -------------------------------------------------------------------------

  r.get('/goals', (req, res) => {
    const rows = db
      .prepare(`${GOALS_SELECT} WHERE g.family_id = ? GROUP BY g.id ORDER BY (g.completed_at IS NOT NULL), g.created_at DESC, g.id DESC`)
      .all(req.family.id);
    res.json(rows.map((g) => goalOut(db, g)));
  });

  r.get('/goals/:id', (req, res) => {
    res.json(goalOut(db, loadGoal(db, req.family.id, toId(req.params.id)), { entries: true }));
  });

  const parseGoal = (req, body, existing) => {
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const out = {};
    if (!existing || has('name')) out.name = cleanStr(body.name, { field: 'Goal name', required: true, max: 80 });
    if (!existing || has('emoji')) out.emoji = cleanStr(body.emoji, { field: 'Emoji', max: EMOJI_MAX });
    if (!existing || has('color')) {
      const color = body.color ?? '#12A594';
      if (!isColor(color)) throw httpError(400, 'Color must be a hex color like #12A594');
      out.color = color.toUpperCase();
    }
    if (!existing || has('target')) {
      if (body.target === undefined || body.target === null || body.target === '') throw httpError(400, 'Target amount is required');
      out.target_cents = toCents(body.target, { field: 'Target' });
    }
    if (!existing || has('owner_id')) {
      const raw = body.owner_id;
      if (raw === undefined || raw === null || raw === '') out.owner_id = null;
      else {
        const id = toId(raw, 'member');
        assertMember(db, req.family.id, id, 'Owner');
        out.owner_id = id;
      }
      if (!canManage(req) && out.owner_id !== req.user.id) throw httpError(403, 'Kids can create goals for themselves');
    }
    if (!existing || has('target_date')) {
      const d = body.target_date;
      if (d === undefined || d === null || d === '') out.target_date = null;
      else if (!isValidDate(d)) throw httpError(400, 'Target date must be a valid YYYY-MM-DD date between 1970 and 2100');
      else out.target_date = d;
    }
    return out;
  };

  r.post('/goals', (req, res) => {
    const body = { ...(req.body ?? {}) };
    if (!canManage(req) && body.owner_id === undefined) body.owner_id = req.user.id;
    const f = parseGoal(req, body);
    const initial = body.saved !== undefined && body.saved !== null && body.saved !== '' && Number(body.saved) !== 0
      ? toCents(body.saved, { field: 'Already saved' }) : 0;
    const id = ctx.tx(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO budget_goals (family_id, name, emoji, color, target_cents, owner_id, target_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.family.id, f.name, f.emoji, f.color, f.target_cents, f.owner_id, f.target_date, req.user.id);
      if (initial) {
        db.prepare("INSERT INTO budget_goal_entries (goal_id, family_id, amount_cents, note, source, user_id) VALUES (?, ?, ?, 'Starting balance', 'manual', ?)")
          .run(lastInsertRowid, req.family.id, initial, req.user.id);
        if (initial >= f.target_cents) db.prepare(`UPDATE budget_goals SET completed_at = ${ISO_NOW} WHERE id = ?`).run(lastInsertRowid);
      }
      return Number(lastInsertRowid);
    });
    const goal = goalOut(db, loadGoal(db, req.family.id, id));
    emit(req, 'goal.created', goal);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'goal', entityId: id,
      summary: `started saving for ${f.emoji ? `${f.emoji} ` : ''}${f.name} · ${money(f.target_cents, req.family.currency)}`,
      link: `/budget/goals?goal=${id}`,
    });
    if (f.owner_id && f.owner_id !== req.user.id) {
      ctx.notify({
        familyId: req.family.id, userIds: [f.owner_id], module: 'budget',
        title: `New savings goal: ${f.name}`, body: `${firstName(req.user.name)} set up a goal of ${money(f.target_cents, req.family.currency)} for you`,
        link: `/budget/goals?goal=${id}`, excludeUserId: req.user.id,
      });
    }
    res.status(201).json(goal);
  });

  r.patch('/goals/:id', (req, res) => {
    const existing = loadGoal(db, req.family.id, toId(req.params.id));
    if (!canEditGoal(req, existing)) throw httpError(403, 'You can only edit your own goals');
    const f = parseGoal(req, req.body ?? {}, existing);
    updateRow(db, 'budget_goals', existing.id, f);
    // Re-evaluate completion when the target moves.
    const saved = goalSaved(db, existing.id);
    const target = f.target_cents ?? existing.target_cents;
    if (saved >= target && !existing.completed_at) db.prepare(`UPDATE budget_goals SET completed_at = ${ISO_NOW} WHERE id = ?`).run(existing.id);
    if (saved < target && existing.completed_at) db.prepare('UPDATE budget_goals SET completed_at = NULL WHERE id = ?').run(existing.id);
    const goal = goalOut(db, loadGoal(db, req.family.id, existing.id));
    emit(req, 'goal.updated', goal);
    res.json(goal);
  });

  r.delete('/goals/:id', (req, res) => {
    const existing = loadGoal(db, req.family.id, toId(req.params.id));
    if (!canEditGoal(req, existing)) throw httpError(403, 'You can only delete your own goals');
    db.prepare('DELETE FROM budget_goals WHERE id = ?').run(existing.id);
    emit(req, 'goal.deleted', { id: existing.id });
    res.json({ ok: true });
  });

  /** Add (positive) or withdraw (negative) money. */
  const addEntry = (req, goal, cents, note, source) => {
    const before = goalSaved(db, goal.id);
    if (before + cents < 0) throw httpError(400, `You can't take out more than ${money(before, req.family.currency)}`);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO budget_goal_entries (goal_id, family_id, amount_cents, note, source, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(goal.id, req.family.id, cents, note, source, req.user.id);
    const after = before + cents;
    let reached = false;
    if (after >= goal.target_cents && !goal.completed_at) {
      db.prepare(`UPDATE budget_goals SET completed_at = ${ISO_NOW} WHERE id = ?`).run(goal.id);
      reached = true;
    } else if (after < goal.target_cents && goal.completed_at) {
      db.prepare('UPDATE budget_goals SET completed_at = NULL WHERE id = ?').run(goal.id);
    }
    return { entryId: Number(lastInsertRowid), reached };
  };

  const afterEntry = (req, goal, cents, reached) => {
    const out = goalOut(db, loadGoal(db, req.family.id, goal.id), { entries: true });
    emit(req, 'goal.updated', out);
    const label = `${goal.emoji ? `${goal.emoji} ` : ''}${goal.name}`;
    if (reached) {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'goal_reached', entityId: goal.id,
        summary: `reached the savings goal ${label} 🎉`, link: `/budget/goals?goal=${goal.id}`,
      });
      ctx.notify({
        familyId: req.family.id, userIds: allIds(db, req.family.id), module: 'budget',
        title: `Goal reached: ${goal.name} 🎉`, body: `${money(goal.target_cents, req.family.currency)} saved — time to celebrate!`,
        link: `/budget/goals?goal=${goal.id}`, excludeUserId: req.user.id,
      });
    } else if (cents > 0) {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'saved', entityId: goal.id,
        summary: `added ${money(cents, req.family.currency)} to ${label}`, link: `/budget/goals?goal=${goal.id}`,
      });
      if (goal.owner_id && goal.owner_id !== req.user.id) {
        ctx.notify({
          familyId: req.family.id, userIds: [goal.owner_id], module: 'budget',
          title: `${firstName(req.user.name)} added ${money(cents, req.family.currency)} to ${goal.name}`,
          body: `${Math.min(100, Math.round((out.saved / out.target) * 100))}% of the way there`,
          link: `/budget/goals?goal=${goal.id}`, excludeUserId: req.user.id,
        });
      }
    }
    return out;
  };

  r.post('/goals/:id/entries', (req, res) => {
    const goal = loadGoal(db, req.family.id, toId(req.params.id));
    const cents = toCents(req.body?.amount, { allowNegative: true });
    if (!canEditGoal(req, goal)) throw httpError(403, 'You can only add to your own goals');
    const note = cleanStr(req.body?.note, { field: 'Note', max: 140 });
    const { reached } = ctx.tx(db, () => addEntry(req, goal, cents, note, 'manual'));
    res.status(201).json(afterEntry(req, goal, cents, reached));
  });

  r.delete('/goals/:id/entries/:entryId', (req, res) => {
    const goal = loadGoal(db, req.family.id, toId(req.params.id));
    if (!canEditGoal(req, goal)) throw httpError(403, 'You can only change your own goals');
    const entry = db.prepare('SELECT * FROM budget_goal_entries WHERE id = ? AND goal_id = ?').get(toId(req.params.entryId), goal.id);
    if (!entry) throw httpError(404, 'Entry not found');
    const saved = goalSaved(db, goal.id) - entry.amount_cents;
    if (saved < 0) throw httpError(400, "Removing that would make the balance negative");
    db.prepare('DELETE FROM budget_goal_entries WHERE id = ?').run(entry.id);
    if (saved < goal.target_cents && goal.completed_at) db.prepare('UPDATE budget_goals SET completed_at = NULL WHERE id = ?').run(goal.id);
    if (saved >= goal.target_cents && !goal.completed_at) db.prepare(`UPDATE budget_goals SET completed_at = ${ISO_NOW} WHERE id = ?`).run(goal.id);
    const out = goalOut(db, loadGoal(db, req.family.id, goal.id), { entries: true });
    emit(req, 'goal.updated', out);
    res.json(out);
  });

  // ---- allowances ----------------------------------------------------------------------------

  r.get('/allowances', (req, res) => {
    res.json(db.prepare('SELECT * FROM budget_allowances WHERE family_id = ? ORDER BY id').all(req.family.id).map(allowanceOut));
  });

  r.put('/allowances/:memberId', (req, res) => {
    requireManager(req, 'set allowances');
    const memberId = toId(req.params.memberId, 'member');
    assertMember(db, req.family.id, memberId);
    const body = req.body ?? {};
    const cents = toCents(body.amount, { field: 'Allowance' });
    const frequency = body.frequency ?? 'weekly';
    if (!['weekly', 'monthly'].includes(frequency)) throw httpError(400, 'Frequency must be weekly or monthly');
    let goalId = null;
    if (body.goal_id !== undefined && body.goal_id !== null && body.goal_id !== '') {
      const goal = loadGoal(db, req.family.id, toId(body.goal_id, 'goal'));
      goalId = goal.id;
    }
    db.prepare(
      `INSERT INTO budget_allowances (family_id, member_id, amount_cents, frequency, goal_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(family_id, member_id) DO UPDATE SET amount_cents = excluded.amount_cents, frequency = excluded.frequency, goal_id = excluded.goal_id`,
    ).run(req.family.id, memberId, cents, frequency, goalId);
    const row = allowanceOut(db.prepare('SELECT * FROM budget_allowances WHERE family_id = ? AND member_id = ?').get(req.family.id, memberId));
    emit(req, 'allowance.updated', row);
    res.json(row);
  });

  r.delete('/allowances/:memberId', (req, res) => {
    requireManager(req, 'change allowances');
    const memberId = toId(req.params.memberId, 'member');
    const { changes } = db.prepare('DELETE FROM budget_allowances WHERE family_id = ? AND member_id = ?').run(req.family.id, memberId);
    if (!changes) throw httpError(404, 'No allowance set up for that member');
    emit(req, 'allowance.deleted', { member_id: memberId });
    res.json({ ok: true });
  });

  /** Pay an allowance now: records a Kids expense and (optionally) deposits it into the linked goal. */
  r.post('/allowances/:memberId/pay', (req, res) => {
    requireManager(req, 'pay allowances');
    const memberId = toId(req.params.memberId, 'member');
    const allowance = db.prepare('SELECT * FROM budget_allowances WHERE family_id = ? AND member_id = ?').get(req.family.id, memberId);
    if (!allowance) throw httpError(404, 'No allowance set up for that member');
    const kid = db.prepare('SELECT u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.family_id = ? AND u.id = ?').get(req.family.id, memberId);
    if (!kid) throw httpError(404, 'Member not found');
    const recordExpense = req.body?.record_expense !== false;
    const goal = allowance.goal_id ? db.prepare('SELECT * FROM budget_goals WHERE id = ? AND family_id = ?').get(allowance.goal_id, req.family.id) : null;
    const kidsCat = db.prepare("SELECT id FROM budget_categories WHERE family_id = ? AND kind = 'expense' AND lower(name) = 'kids'").get(req.family.id);
    let reached = false;
    let txId = null;
    ctx.tx(db, () => {
      if (recordExpense) {
        txId = Number(
          db.prepare(
            `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, date, paid_by, created_by)
             VALUES (?, 'expense', ?, ?, ?, ?, ?, ?)`,
          ).run(req.family.id, allowance.amount_cents, kidsCat?.id ?? null, `Allowance — ${firstName(kid.name)}`, requestToday(ctx, req), req.user.id, req.user.id).lastInsertRowid,
        );
      }
      if (goal) reached = addEntry(req, goal, allowance.amount_cents, `${allowance.frequency === 'weekly' ? 'Weekly' : 'Monthly'} allowance`, 'allowance').reached;
      db.prepare(`UPDATE budget_allowances SET last_paid_at = ${ISO_NOW} WHERE id = ?`).run(allowance.id);
    });
    const row = allowanceOut(db.prepare('SELECT * FROM budget_allowances WHERE id = ?').get(allowance.id));
    emit(req, 'allowance.paid', row);
    if (txId) emit(req, 'transaction.created', txOut(loadTx(db, req.family.id, txId)));
    if (goal) afterEntry(req, goal, 0, reached);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'allowance', entityId: allowance.id,
      summary: `paid ${firstName(kid.name)}'s allowance · ${money(allowance.amount_cents, req.family.currency)}${goal ? ` → ${goal.name}` : ''}`,
      link: '/budget/goals',
    });
    ctx.notify({
      familyId: req.family.id, userIds: [memberId], module: 'budget',
      title: `Allowance day! +${money(allowance.amount_cents, req.family.currency)}`,
      body: goal ? `Added to your goal “${goal.name}”` : `${firstName(req.user.name)} paid your allowance`,
      link: '/budget/goals', excludeUserId: req.user.id,
    });
    res.json({ allowance: row, transaction_id: txId, goal_id: goal?.id ?? null });
  });

  return r;
}

// ---- hooks ----------------------------------------------------------------------------------

export function search(ctx, familyId, q) {
  const family = ctx.db.prepare('SELECT currency FROM families WHERE id = ?').get(familyId);
  const txs = ctx.db
    .prepare(
      `${TX_SELECT} WHERE t.family_id = ? AND t.deleted_at IS NULL
       AND (search_match(t.description, ?) OR search_match(t.notes, ?)) ORDER BY t.date DESC LIMIT 5`,
    )
    .all(familyId, q, q)
    .map((row) => ({
      title: row.description || row.c_name || 'Transaction',
      subtitle: `${row.kind === 'income' ? '+' : '−'}${money(row.amount_cents, family?.currency)} · ${row.c_name ?? 'Uncategorized'} · ${row.date}`,
      link: `/budget/transactions?month=${monthOf(row.date)}&tx=${row.id}`,
    }));
  const goals = ctx.db
    .prepare("SELECT * FROM budget_goals WHERE family_id = ? AND search_match(name, ?) LIMIT 3")
    .all(familyId, q)
    .map((g) => ({ title: `${g.emoji ? `${g.emoji} ` : ''}${g.name}`, subtitle: `Savings goal · ${money(g.target_cents, family?.currency)}`, link: `/budget/goals?goal=${g.id}` }));
  const bills = ctx.db
    .prepare("SELECT * FROM budget_recurring WHERE family_id = ? AND active = 1 AND search_match(description, ?) LIMIT 3")
    .all(familyId, q)
    .map((b) => ({ title: b.description, subtitle: `Monthly bill · ${money(b.amount_cents, family?.currency)} on day ${b.day_of_month}`, link: '/budget/bills' }));
  return [...txs, ...goals, ...bills].slice(0, 8);
}

export function dashboard(ctx, req) {
  const { db } = ctx;
  ensureDefaults(db, req.family.id);
  const today = requestToday(ctx, req);
  const month = monthOf(today);
  const s = buildSummary(db, req.family.id, month);
  const bills = billsForMonth(db, req.family.id, month, today);
  return {
    month,
    currency: req.family.currency,
    income: s.totals.income,
    spent: s.totals.spent,
    balance: s.totals.balance,
    over_budget: s.categories
      .filter((c) => c.kind === 'expense' && c.monthly_limit && c.total > c.monthly_limit)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, spent: c.total, limit: c.monthly_limit })),
    bills_due: bills
      .filter((b) => ['overdue', 'due_today', 'upcoming'].includes(b.status) && b.kind === 'expense')
      .slice(0, 5)
      .map((b) => ({ id: b.id, description: b.description, amount: b.amount, due_date: b.due_date, status: b.status })),
    // Ties (seeded goals share a timestamp) keep the order they always had: oldest id first.
    goals: db
      .prepare(`${GOALS_SELECT} WHERE g.family_id = ? AND g.completed_at IS NULL GROUP BY g.id ORDER BY g.created_at DESC, g.id LIMIT 3`)
      .all(req.family.id)
      .map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, target: fromCents(g.target_cents), saved: fromCents(g.saved_cents) })),
  };
}
