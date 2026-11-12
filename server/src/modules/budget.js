// Family budget — module "budget", mounted at /api/budget.
// Transactions (expense/income) with categories + monthly limits, recurring monthly bills,
// savings goals and kids' allowances. See docs/MODULE_SPECS.md ("budget").
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { activityAudience } from '../activity.js';
import { ISO_NOW, searchMatch } from '../db.js';
import { cleanStr, firstName, httpError, isColor, toId } from '../util.js';
import {
  BILL_SELECT, ICONS, KINDS, TX_SELECT, addMonths, autoAmount, billOut, billStatus, canManage, categoryOut, dateKey, dueDate,
  daysInMonth, ensureDefaults, familyToday, fromCents, generateDue, isValidDate, monthEnd, monthLabel, monthOf, monthStart, money, parseMonth,
  recordBillPayment, requestToday, toCents, txOut, upgradeMeta,
} from './budget/lib.js';
import {
  ImportError, MAX_FILE_BYTES, MAX_ROWS, MESSAGES, detectRecurring, maskDigits, merchantKey, normDesc, parseInWorker, prettyMerchant, ruleCategory,
} from './budget/import.js';

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
  // Automatic monthly contributions: opt-in per goal, one run row per goal per (family-local) month.
  'ALTER TABLE budget_goals ADD COLUMN auto_monthly INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS budget_goal_runs (
     goal_id INTEGER NOT NULL REFERENCES budget_goals(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     month TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (goal_id, month))`,
  // Bank statement imports (see budget/import.js). Imported rows keep only date, amount, kind,
  // category and — sealed with ctx.box — description and running balance.
  `CREATE TABLE IF NOT EXISTS budget_imports (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     bank TEXT NOT NULL,
     format TEXT NOT NULL,
     account_label TEXT NOT NULL,
     account_last4 TEXT,
     period_from TEXT NOT NULL,
     period_to TEXT NOT NULL,
     row_count INTEGER NOT NULL DEFAULT 0,
     visibility TEXT NOT NULL DEFAULT 'adults' CHECK (visibility IN ('adults','private')),
     opening_balance TEXT,
     closing_balance TEXT,
     income_cents INTEGER NOT NULL DEFAULT 0,
     spending_cents INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     deleted_at TEXT,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_imports_family ON budget_imports(family_id)`,
  // Who can see a transaction / bill: 'family' (everyone; all rows from before), 'adults', 'private' (whoever added it).
  "ALTER TABLE budget_transactions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','adults','private'))",
  'ALTER TABLE budget_transactions ADD COLUMN import_id INTEGER REFERENCES budget_imports(id) ON DELETE SET NULL',
  'ALTER TABLE budget_transactions ADD COLUMN balance TEXT',
  `CREATE INDEX IF NOT EXISTS idx_budget_tx_import ON budget_transactions(import_id)`,
  "ALTER TABLE budget_recurring ADD COLUMN visibility TEXT NOT NULL DEFAULT 'family' CHECK (visibility IN ('family','adults','private'))",
  // Learned "merchant -> category" choices per family (merchant key sealed, matched in JS).
  `CREATE TABLE IF NOT EXISTS budget_merchant_rules (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
     merchant TEXT NOT NULL,
     category_id INTEGER NOT NULL REFERENCES budget_categories(id) ON DELETE CASCADE,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS idx_budget_rules_family ON budget_merchant_rules(family_id)`,
  // A rule is seen by the same people as the import it was learned from ('adults', or 'private' to created_by);
  // import_id = the import that last set it (undoing that import removes it).
  "ALTER TABLE budget_merchant_rules ADD COLUMN visibility TEXT NOT NULL DEFAULT 'adults' CHECK (visibility IN ('adults','private'))",
  'ALTER TABLE budget_merchant_rules ADD COLUMN import_id INTEGER',
  // Money moved between the family's own accounts: listed, but left out of every income/spending total.
  'ALTER TABLE budget_transactions ADD COLUMN transfer INTEGER NOT NULL DEFAULT 0',
  // The import that marked a bill month paid (undo unlinks it again).
  'ALTER TABLE budget_recurring_runs ADD COLUMN import_id INTEGER',
  // The import whose commit flagged this row as the other side of a transfer (undo clears it again).
  'ALTER TABLE budget_transactions ADD COLUMN transfer_by_import INTEGER',
  // The import a bill was suggested from ('expected' months until a statement covers them).
  'ALTER TABLE budget_recurring ADD COLUMN import_id INTEGER',
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
export const VISIBILITIES = ['family', 'adults', 'private'];

/**
 * SQL condition for budget_transactions / budget_recurring rows (alias `a`) the requester may see:
 * 'family' rows for everyone, 'adults' rows for grown-ups, 'private' rows only for whoever added them
 * (who always sees their own). Inlines two integers, so it drops into any query without new args.
 */
function visibleSql(req, a = 't') {
  const uid = Number(req?.user?.id);
  if (!Number.isInteger(uid)) return `${a}.visibility = 'family'`;
  return `(${a}.visibility = 'family' OR ${a}.created_by = ${uid} OR (${a}.visibility = 'adults' AND ${canManage(req) ? 1 : 0}))`;
}

/**
 * Encryption at rest (ctx.box) for budget text only some members may see: the description and
 * notes of imported rows and of 'adults'/'private' rows (plus imported rows' balance), and the
 * description and notes of 'adults'/'private' bills (the ones made from an import). Family-visible
 * manual rows and bills stay plaintext (SQL search). open() passes plaintext through.
 */
const sealsTx = (row) => !!row.import_id || (row.visibility ?? 'family') !== 'family';
const sealsBill = (row) => (row.visibility ?? 'family') !== 'family';
// ponytail: module-level db → box registry, so the db-only helpers (billsForMonth, loadBill) can open bills.
const BOXES = new WeakMap();
const boxFor = (db) => BOXES.get(db) ?? { open: (v) => v, seal: (v) => v };

function openTx(box, row) {
  if (!row) return row;
  try {
    return {
      ...row, description: box.open(row.description), notes: box.open(row.notes), balance: box.open(row.balance),
      ...(row.bill_description !== undefined ? { bill_description: box.open(row.bill_description) } : {}),
    };
  } catch {
    return { ...row, description: '(unreadable)', notes: null, balance: null, bill_description: null };
  }
}
function openBill(db, row) {
  if (!row) return row;
  const box = boxFor(db);
  try {
    return { ...row, description: box.open(row.description), notes: box.open(row.notes) };
  } catch {
    return { ...row, description: '(unreadable)', notes: null };
  }
}

/**
 * Seal budget text written before it was encrypted (rows/bills that are imported, adults-only or
 * private), once per database at startup. Runs with secure_delete on and truncates the WAL after,
 * so the replaced plaintext doesn't linger in the file.
 */
const sealed = new WeakSet();
export function sealLegacyBudget(ctx) {
  const { db, box } = ctx;
  if (sealed.has(db)) return 0;
  sealed.add(db);
  let n = 0;
  ctx.tx(db, () => {
    for (const t of db.prepare("SELECT id, description, notes, balance FROM budget_transactions WHERE import_id IS NOT NULL OR visibility != 'family'").all()) {
      const fields = ['description', 'notes', 'balance'].filter((k) => t[k] != null && !box.isSealed(t[k]));
      if (!fields.length) continue;
      db.prepare(`UPDATE budget_transactions SET ${fields.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((k) => box.seal(t[k])), t.id);
      n++;
    }
    for (const b of db.prepare("SELECT id, description, notes FROM budget_recurring WHERE visibility != 'family'").all()) {
      const fields = ['description', 'notes'].filter((k) => b[k] != null && !box.isSealed(b[k]));
      if (!fields.length) continue;
      db.prepare(`UPDATE budget_recurring SET ${fields.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map((k) => box.seal(b[k])), b.id);
      n++;
    }
  });
  if (n) scrubFreedPages(db);
  return n;
}

/** Push deleted/replaced pages out of the WAL (secure_delete already zeroes them in the db file). */
function scrubFreedPages(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch { /* busy: the next checkpoint does it */ }
}

const adultIds = (db, familyId) => memberIds(db, familyId).filter((m) => m.role !== 'child').map((m) => m.user_id);
const allIds = (db, familyId) => memberIds(db, familyId).map((m) => m.user_id);

/** JS twin of visibleSql: may the requester see a row with this visibility / creator? */
const canSee = (req, visibility, createdBy) =>
  visibility === 'family' || createdBy === req.user.id || (visibility === 'adults' && canManage(req));

const RANK = { private: 0, adults: 1, family: 2 };
/**
 * May transaction `t` be recorded as a payment of bill `b`? Only when everyone who can see the
 * transaction can also see the bill (so recurring_id never points somewhere they can't follow), and
 * private ones only within one person's own data: a private row pays only its owner's private bill,
 * and a private bill is paid only by its owner's private rows. (An adults-only row may pay a family
 * bill: others then see the month as paid, without the payment's details.)
 */
export const canLinkPayment = (t, b) => {
  if (t.visibility === 'private' || b.visibility === 'private') return t.visibility === b.visibility && t.created_by === b.created_by;
  return RANK[t.visibility] <= RANK[b.visibility];
};

/** Who may see a row with this visibility; null = the whole family. */
function audienceOf(db, familyId, visibility, createdBy) {
  if (visibility === 'private') return [createdBy].filter(Boolean);
  if (visibility === 'adults') return [...new Set([...adultIds(db, familyId), createdBy].filter(Boolean))];
  return null;
}

function requireManager(req, what = 'do that') {
  if (!canManage(req)) throw httpError(403, `Ask a parent to ${what}`);
}

function getCategory(db, familyId, id) {
  const row = db.prepare('SELECT * FROM budget_categories WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!row) throw httpError(404, 'Category not found');
  return row;
}

function loadTx(db, req, id) {
  const row = db.prepare(`${TX_SELECT} WHERE t.id = ? AND t.family_id = ? AND t.deleted_at IS NULL AND ${visibleSql(req)}`).get(id, req.family.id);
  if (!row) throw httpError(404, 'Transaction not found');
  return row;
}

function loadBill(db, req, id) {
  const row = db.prepare(`${BILL_SELECT} WHERE b.id = ? AND b.family_id = ? AND ${visibleSql(req, 'b')}`).get(id, req.family.id);
  if (!row) throw httpError(404, 'Bill not found');
  return openBill(db, row);
}

function loadGoal(db, familyId, id) {
  const row = db.prepare('SELECT * FROM budget_goals WHERE id = ? AND family_id = ?').get(id, familyId);
  if (!row) throw httpError(404, 'Goal not found');
  return row;
}

/** Entry totals per goal: on goal rows from GOALS_SELECT, or `goalStats(db, id)` for a single one. */
const GOAL_STATS = 'COALESCE(SUM(e.amount_cents), 0) AS saved_cents, COUNT(e.id) AS entry_count, MAX(e.created_at) AS last_entry_at';
// auto_last_month: the latest month claimed by automatic contributions (the client works out the next one from it).
const LAST_RUN = (id) => `(SELECT MAX(month) FROM budget_goal_runs r WHERE r.goal_id = ${id}) AS auto_last_month`;
const GOALS_SELECT = `SELECT g.*, ${GOAL_STATS}, ${LAST_RUN('g.id')} FROM budget_goals g LEFT JOIN budget_goal_entries e ON e.goal_id = g.id`;
const goalStats = (db, goalId) => db.prepare(`SELECT ${GOAL_STATS}, ${LAST_RUN('$id')} FROM budget_goal_entries e WHERE e.goal_id = $id`).get({ id: goalId });
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
    auto_monthly: !!row.auto_monthly,
    auto_last_month: stats.auto_last_month,
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

/** Spent in a category, counting only what every grown-up can see (the over-budget alert goes to all of them). */
function spentIn(db, familyId, categoryId, month) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM budget_transactions
       WHERE family_id = ? AND category_id = ? AND kind = 'expense' AND deleted_at IS NULL AND transfer = 0 AND visibility != 'private' AND date BETWEEN ? AND ?`,
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
    ctx.sendToUsers(adultIds(ctx.db, req.family.id), 'budget.category.over', { category_id: categoryId, month }, req.family.id);
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
  if (!existing || has('description')) out.description = maskDigits(cleanStr(body.description, { field: 'Description', max: 140 }) ?? '') || null;
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
  if (!existing || has('transfer')) {
    if (body.transfer !== undefined && typeof body.transfer !== 'boolean') throw httpError(400, 'transfer must be true or false');
    out.transfer = body.transfer ? 1 : 0;
  }
  if (!existing || has('visibility')) {
    const v = body.visibility ?? existing?.visibility ?? 'family';
    if (!VISIBILITIES.includes(v)) throw httpError(400, 'Visibility must be family, adults or private');
    if (v !== 'family' && !canManage(req)) throw httpError(403, 'Ask a parent to hide a transaction');
    if (v === 'private' && existing && existing.created_by !== req.user.id) throw httpError(403, 'Only the person who added it can make it private');
    // Showing a row to more people (and any change on an imported row) is up to whoever added it.
    if (existing && v !== existing.visibility && existing.created_by !== req.user.id && (existing.import_id || RANK[v] > RANK[existing.visibility])) {
      throw httpError(403, 'Only the person who added it can share it more widely');
    }
    out.visibility = v;
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
function buildSummary(db, req, month) {
  const familyId = req.family.id;
  const vis = visibleSql(req, 'budget_transactions');
  const start = monthStart(month);
  const end = monthEnd(month);
  const catRows = db.prepare('SELECT * FROM budget_categories WHERE family_id = ? ORDER BY sort, id').all(familyId);
  const catAgg = db
    .prepare(
      `SELECT category_id, kind, SUM(amount_cents) AS s, COUNT(*) AS n FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND transfer = 0 AND ${vis} AND date BETWEEN ? AND ? GROUP BY category_id, kind`,
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
       WHERE family_id = ? AND deleted_at IS NULL AND transfer = 0 AND ${vis} AND date BETWEEN ? AND ? GROUP BY m, kind`,
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
       WHERE family_id = ? AND deleted_at IS NULL AND transfer = 0 AND ${vis} AND kind = 'expense' AND date BETWEEN ? AND ?
       GROUP BY paid_by ORDER BY s DESC`,
    )
    .all(familyId, start, end)
    .map((r) => ({ user_id: r.user_id, spent: fromCents(r.s), count: r.n }));

  // Cumulative daily spending (for the "pace" sparkline).
  const daily = db
    .prepare(
      `SELECT date, SUM(amount_cents) AS s FROM budget_transactions
       WHERE family_id = ? AND deleted_at IS NULL AND transfer = 0 AND ${vis} AND kind = 'expense' AND date BETWEEN ? AND ? GROUP BY date`,
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

const shiftDay = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/** Bills for a month; with `req` only the ones that person may see (the sweep passes none: all). */
function billsForMonth(db, familyId, month, today = dateKey(), req = null) {
  // covered_to: for a bill suggested by an import, the end of the latest statement of that account.
  const rows = db.prepare(
    `SELECT x.*, (SELECT MAX(i.period_to) FROM budget_imports i WHERE i.family_id = x.family_id AND i.deleted_at IS NULL
         AND i.account_last4 IS (SELECT s.account_last4 FROM budget_imports s WHERE s.id = x.import_id)) AS covered_to,
       (SELECT s.period_to FROM budget_imports s WHERE s.id = x.import_id) AS source_to
     FROM (${BILL_SELECT} WHERE b.family_id = ? ${req ? `AND ${visibleSql(req, 'b')}` : ''}) x ORDER BY x.day_of_month, x.id`,
  ).all(familyId).map((b) => openBill(db, b));
  const runs = new Map(
    db
      .prepare(
        `SELECT r.*, t.amount_cents AS t_amount, t.date AS t_date, t.paid_by AS t_paid_by, ${req ? visibleSql(req, 't') : '1'} AS t_visible FROM budget_recurring_runs r
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
    let status = billStatus(b, month, run, today);
    if (status === 'inactive') continue;
    // A bill from an import isn't overdue before a statement covering its due date arrives (until 5 days late).
    const covered = b.covered_to ?? b.source_to;
    const due = dueDate(month, b.day_of_month);
    if (b.import_id && covered && !run && ['overdue', 'due_today', 'upcoming'].includes(status) && due > covered && today <= shiftDay(due, 5)) status = 'expected';
    out.push(
      billOut(b, {
        month,
        due_date: dueDate(month, b.day_of_month),
        status,
        // The payment's details only for whoever can see that transaction.
        transaction_id: run?.t_visible ? run.transaction_id ?? null : null,
        paid_amount: run?.t_amount && run.t_visible ? fromCents(run.t_amount) : null,
        paid_date: run?.t_visible ? run.t_date ?? null : null,
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
  if (!existing || has('description')) out.description = maskDigits(cleanStr(body.description, { field: 'Name', required: true, max: 120 }));
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

/** Add (positive) or withdraw (negative) money. */
function addEntry(db, req, goal, cents, note, source) {
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
}

function afterEntry(ctx, req, goal, cents, reached) {
  const { db } = ctx;
  const out = goalOut(db, loadGoal(db, req.family.id, goal.id), { entries: true });
  ctx.broadcast(req.family.id, 'budget.goal.updated', out);
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
}

/**
 * Automatic monthly goal contributions for the family's month of `today` (all auto goals, or just
 * `goalId`). Every auto goal whose target month hasn't passed claims the month in budget_goal_runs
 * (PK goal_id+month) — reached goals and zero amounts too — and only gets an entry when money is
 * still needed. So it happens once per goal per month: repeated or concurrent sweeps never double
 * up, a deleted entry isn't re-created, and a reached goal that dips below target mid-month waits
 * for the 1st. A target date earlier this month still counts: everything left is added now.
 * With `req` (a person switching the option on) the entry is theirs and is logged like a normal
 * deposit; otherwise (the sweep) the family gets one summary of everything this run added.
 * Returns the number of contributions made.
 * ponytail: only the current month — months the server was down for are not backfilled.
 */
export function autoContribute(ctx, familyId, today, { goalId = null, req = null } = {}) {
  const { db } = ctx;
  const month = monthOf(today);
  const goals = db
    .prepare(`SELECT * FROM budget_goals WHERE family_id = ? AND auto_monthly = 1 AND target_date >= ?${goalId ? ' AND id = ?' : ''}`)
    .all(familyId, monthStart(month), ...(goalId ? [goalId] : []));
  if (!goals.length) return 0;
  const family = db.prepare('SELECT currency FROM families WHERE id = ?').get(familyId);
  const by = req ?? { family: { id: familyId, currency: family?.currency ?? 'USD' }, user: { id: null } }; // null user = Hearth
  const done = [];
  for (const goal of goals) {
    const made = ctx.tx(db, () => {
      if (!db.prepare('INSERT OR IGNORE INTO budget_goal_runs (goal_id, family_id, month) VALUES (?, ?, ?)').run(goal.id, familyId, month).changes) return null;
      const cents = goal.completed_at ? 0 : autoAmount(goal.target_cents - goalSaved(db, goal.id), month, goal.target_date);
      return cents > 0 ? { cents, ...addEntry(db, by, goal, cents, `Monthly contribution · ${monthLabel(month, 'short')}`, 'auto') } : null;
    });
    if (!made) continue;
    afterEntry(ctx, by, goal, req ? made.cents : 0, made.reached); // goal.updated + the usual "goal reached" celebration
    done.push({ goal, cents: made.cents });
  }
  if (done.length && !req) {
    const fmt = (c) => money(c, by.family.currency);
    const total = fmt(done.reduce((s, d) => s + d.cents, 0));
    const parts = done.map(({ goal, cents }) => `${goal.emoji ? `${goal.emoji} ` : ''}${goal.name} ${fmt(cents)}`).join(' · ');
    // Grown-ups plus the kids whose own goals got money (the Wall row is limited to the same people).
    const audience = [...new Set([...adultIds(db, familyId), ...done.map((d) => d.goal.owner_id).filter(Boolean)])];
    ctx.logActivity({ familyId, module: 'budget', verb: 'auto_saved', summary: `saved ${total} automatically: ${parts}`, link: '/budget/goals', audience });
    ctx.notify({ familyId, userIds: audience, module: 'budget', title: `Saved ${total} automatically`, body: parts, link: '/budget/goals' });
  }
  return done.length;
}

/** Periodic housekeeping: auto bills, auto goal contributions, due-today reminders, purge of soft-deleted transactions. */
export function sweep(ctx, todayOverride = null) {
  const { db } = ctx;
  if (ctx.box) BOXES.set(db, ctx.box);
  const families = db
    .prepare('SELECT family_id FROM budget_recurring WHERE active = 1 UNION SELECT family_id FROM budget_goals WHERE auto_monthly = 1')
    .all().map((r) => r.family_id);
  for (const familyId of families) {
    // Each family's own calendar day (from the time zone its members' browsers report).
    const today = todayOverride ?? familyToday(ctx, familyId);
    autoContribute(ctx, familyId, today);
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
      // Bills from an import only remind the people who can see them.
      const allowed = audienceOf(db, familyId, bill.visibility, bill.created_by);
      const wanted = bill.paid_by ? [bill.paid_by] : adultIds(db, familyId);
      const mine = allowed ? wanted.filter((id) => allowed.includes(id)) : wanted;
      ctx.notify({
        familyId,
        userIds: mine.length ? mine : allowed,
        module: 'budget',
        title: bill.visibility === 'family' ? `${bill.description} is due today` : 'A bill is due today', // no private names at rest
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
  const gone = db.prepare('DELETE FROM budget_imports WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff).changes; // undone imports (sealed balances)
  if (gone) scrubFreedPages(db);
}

// --------------------------------------------------------------------------------------------

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const r = Router();
  upgradeMeta(db);
  BOXES.set(db, ctx.box);
  // Deleted budget rows (a member leaving, purged undo) are zeroed in the file, not just unlinked.
  // ponytail: connection-wide, so every module's deletes pay the (small) cost.
  db.exec('PRAGMA secure_delete = ON');
  sealLegacyBudget(ctx);

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
  /** Live event about a transaction/bill `row`: only the people who can see it hear about it. */
  const emitRow = (req, type, payload, row = payload) => {
    const audience = audienceOf(db, req.family.id, row.visibility ?? 'family', row.created_by);
    if (audience) ctx.sendToUsers(audience, `budget.${type}`, payload, req.family.id);
    else emit(req, type, payload);
  };
  /** [description, notes] as stored: sealed when `seal`, else plain. */
  const sealText = (t, seal) => [t.description ?? null, t.notes ?? null].map((v) => (seal ? ctx.box.seal(v) : v));
  /** A transaction for `req`: sealed text opened, and the bill it pays only when they can see that bill. */
  const txJson = (row, req) => {
    const t = openTx(ctx.box, row);
    const out = { ...txOut(t), merchant: t.import_id ? prettyMerchant(merchantKey(t.description)) || null : null };
    if (out.recurring_id && t.rb_visibility && !canSee(req, t.rb_visibility, t.rb_created_by)) out.recurring_id = null;
    return out;
  };

  // ---- overview ------------------------------------------------------------------------------

  r.get('/', (req, res) => {
    prepare(req);
    res.json({ ok: true, currency: req.family.currency });
  });

  r.get('/summary', (req, res) => {
    const today = prepare(req);
    const month = parseMonth(req.query.month, monthOf(today));
    const summary = buildSummary(db, req, month);
    const bills = billsForMonth(db, req.family.id, month, today, req);
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
    const bills = billsForMonth(db, req.family.id, monthOf(today), today, req);
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
    const where = ['t.family_id = ?', 't.deleted_at IS NULL', visibleSql(req)];
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
      const bill = loadBill(db, req, toId(req.query.recurring_id, 'bill')); // 404 for a bill they can't see
      where.push('t.recurring_id = ?');
      args.push(bill.id);
    }
    if (req.query.import_id) {
      where.push('t.import_id = ?');
      args.push(toId(req.query.import_id, 'import'));
    }
    if (q) {
      // Imported descriptions are sealed: those rows are matched in JS (sealedMatches).
      where.push(`((t.import_id IS NULL AND t.visibility = 'family' AND (t.description LIKE '%' || ? || '%' OR t.notes LIKE '%' || ? || '%')) OR c.name LIKE '%' || ? || '%'
        OR t.id IN (SELECT value FROM json_each(?)))`);
      args.push(q, q, q, JSON.stringify(sealedMatches(req, q)));
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
    const items = rows.slice(0, limit).map((t) => txJson(t, req));
    if (req.query.page === '1') {
      const last = items[items.length - 1];
      return res.json({ items, next_cursor: more && last ? `${last.date}~${last.id}` : null });
    }
    res.json(items);
  });

  r.get('/transactions/:id', (req, res) => {
    res.json(txJson(loadTx(db, req, toId(req.params.id)), req));
  });

  r.post('/transactions', (req, res) => {
    ensureDefaults(db, req.family.id);
    const f = parseTxBody(db, req, req.body ?? {}, null, requestToday(ctx, req));
    const month = monthOf(f.date);
    const before = f.category_id && f.kind === 'expense' ? spentIn(db, req.family.id, f.category_id, month) : 0;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, notes, date, paid_by, created_by, visibility, transfer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.family.id, f.kind, f.amount_cents, f.category_id, ...sealText(f, f.visibility !== 'family'), f.date, f.paid_by, req.user.id, f.visibility, f.transfer);
    const row = txJson(loadTx(db, req, Number(lastInsertRowid)), req);
    emitRow(req, 'transaction.created', row);
    // Rows not everyone sees keep their description out of the Wall (it's sealed in the row itself).
    const label = f.visibility === 'family' ? row.description || row.category?.name || (row.kind === 'income' ? 'Income' : 'Expense') : null;
    ctx.logActivity({
      familyId: req.family.id,
      userId: req.user.id,
      module: 'budget',
      verb: row.kind === 'income' ? 'income' : 'expense',
      entityId: row.id,
      summary: `${row.kind === 'income' ? 'added income' : 'added an expense'}${label ? `: ${label}` : ''} · ${money(f.amount_cents, req.family.currency)}`,
      link: `/budget/transactions?month=${month}&tx=${row.id}`,
      audience: audienceOf(db, req.family.id, f.visibility, req.user.id),
    });
    checkOverBudget(ctx, req, f.category_id, month, before);
    res.status(201).json(row);
  });

  r.patch('/transactions/:id', (req, res) => {
    const existing = loadTx(db, req, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only edit transactions you added');
    // Imported rows: other grown-ups may re-file them (category, amount, date…), but their wording,
    // transfer flag and who sees them stay with the person who imported them.
    const f = parseTxBody(db, req, req.body ?? {}, existing, requestToday(ctx, req));
    if (existing.import_id && existing.created_by !== req.user.id) {
      const was = openTx(ctx.box, existing);
      if ((f.description !== undefined && f.description !== was.description) || (f.transfer !== undefined && f.transfer !== (existing.transfer ? 1 : 0))) {
        throw httpError(403, 'Only the person who imported it can change its description or transfer flag');
      }
    }
    const next = { ...existing, ...f };
    const month = monthOf(next.date);
    const before = next.category_id && next.kind === 'expense'
      ? spentIn(db, req.family.id, next.category_id, month) - (existing.category_id === next.category_id && monthOf(existing.date) === month && existing.kind === 'expense' ? existing.amount_cents : 0)
      : 0;
    // Text is stored sealed or plain to match the row's (new) visibility.
    const plain = openTx(ctx.box, existing);
    const text = { description: f.description !== undefined ? f.description : plain.description, notes: f.notes !== undefined ? f.notes : plain.notes };
    [f.description, f.notes] = sealText(text, sealsTx({ import_id: existing.import_id, visibility: f.visibility ?? existing.visibility }));
    updateRow(db, 'budget_transactions', existing.id, f, `updated_at = ${ISO_NOW}`);
    const row = txJson(loadTx(db, req, existing.id), req);
    if (f.visibility && f.visibility !== existing.visibility) {
      // Its Wall entry follows the new audience; whoever can't see it any more drops it.
      const audience = audienceOf(db, req.family.id, f.visibility, existing.created_by);
      const acts = db.prepare("SELECT id FROM activity WHERE family_id = ? AND module = 'budget' AND entity_id = ? AND verb IN ('expense','income')").all(req.family.id, existing.id).map((a) => a.id);
      for (const id of acts) db.prepare('UPDATE activity SET audience = ? WHERE id = ?').run(audience ? JSON.stringify(audience) : null, id);
      if (f.visibility !== 'family') { // its Wall line loses the description too
        const generic = `${existing.kind === 'income' ? 'added income' : 'added an expense'} · ${money(existing.amount_cents, req.family.currency)}`;
        for (const id of acts) db.prepare('UPDATE activity SET summary = ? WHERE id = ?').run(generic, id);
      }
      const gone = audience ? allIds(db, req.family.id).filter((u) => !audience.includes(u)) : [];
      if (gone.length) {
        ctx.sendToUsers(gone, 'budget.transaction.deleted', { id: existing.id }, req.family.id);
        if (acts.length) ctx.sendToUsers(gone, 'activity.removed', { ids: acts }, req.family.id);
      }
    }
    emitRow(req, 'transaction.updated', row);
    checkOverBudget(ctx, req, next.category_id, month, before);
    res.json(row);
  });

  r.delete('/transactions/:id', (req, res) => {
    const existing = loadTx(db, req, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only delete transactions you added');
    db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE id = ?`).run(existing.id);
    emitRow(req, 'transaction.deleted', { id: existing.id }, existing);
    res.json({ ok: true, id: existing.id });
  });

  /** Undo a delete (soft-deleted rows are kept for 2 days). */
  r.post('/transactions/:id/restore', (req, res) => {
    const id = toId(req.params.id);
    const row = db.prepare(`SELECT * FROM budget_transactions t WHERE id = ? AND family_id = ? AND deleted_at IS NOT NULL AND ${visibleSql(req)}`).get(id, req.family.id);
    if (!row) throw httpError(404, 'Transaction not found');
    if (!canEditTx(req, row)) throw httpError(403, 'You can only restore transactions you added');
    if (row.import_id && db.prepare('SELECT 1 FROM budget_imports WHERE id = ? AND deleted_at IS NOT NULL').get(row.import_id)) {
      throw httpError(409, 'That import was undone — import the statement again to bring it back');
    }
    if (row.recurring_id) {
      // A bill payment can only come back while its month still points at it (not re-paid, skipped or reset).
      const linked = db.prepare('SELECT 1 FROM budget_recurring_runs WHERE recurring_id = ? AND transaction_id = ?').get(row.recurring_id, id);
      if (!linked) throw httpError(409, 'That bill has been paid or skipped again since — this payment can’t be restored');
    }
    db.prepare('UPDATE budget_transactions SET deleted_at = NULL WHERE id = ?').run(id);
    const out = txJson(loadTx(db, req, id), req);
    emitRow(req, 'transaction.created', out);
    res.json(out);
  });

  r.post('/transactions/:id/receipt', ctx.upload.single('file'), (req, res) => {
    const existing = loadTx(db, req, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only change transactions you added');
    if (!req.file) throw httpError(400, 'Choose a photo of the receipt');
    if (!/^image\//.test(req.file.mimetype) && req.file.mimetype !== 'application/pdf') throw httpError(400, 'Receipts must be an image or a PDF');
    if (existing.receipt_url) ctx.removeFile(existing.receipt_url);
    db.prepare(`UPDATE budget_transactions SET receipt_url = ?, updated_at = ${ISO_NOW} WHERE id = ?`).run(req.file.url, existing.id);
    const row = txJson(loadTx(db, req, existing.id), req);
    emitRow(req, 'transaction.updated', row);
    res.json(row);
  });

  r.delete('/transactions/:id/receipt', (req, res) => {
    const existing = loadTx(db, req, toId(req.params.id));
    if (!canEditTx(req, existing)) throw httpError(403, 'You can only change transactions you added');
    if (existing.receipt_url) ctx.removeFile(existing.receipt_url);
    db.prepare(`UPDATE budget_transactions SET receipt_url = NULL, updated_at = ${ISO_NOW} WHERE id = ?`).run(existing.id);
    const row = txJson(loadTx(db, req, existing.id), req);
    emitRow(req, 'transaction.updated', row);
    res.json(row);
  });

  // ---- recurring bills ---------------------------------------------------------------------

  r.get('/recurring', (req, res) => {
    const today = prepare(req);
    const month = parseMonth(req.query.month, monthOf(today));
    res.json(billsForMonth(db, req.family.id, month, today, req));
  });

  const billForMonth = (req, id, month, today = requestToday(ctx, req)) =>
    billsForMonth(db, req.family.id, month, today, req).find((b) => b.id === id) ?? billOut(loadBill(db, req, id));

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
    const existing = loadBill(db, req, toId(req.params.id));
    const f = parseBillBody(db, req, req.body ?? {}, existing);
    if (sealsBill(existing)) for (const k of ['description', 'notes']) if (f[k] !== undefined) f[k] = ctx.box.seal(f[k]);
    updateRow(db, 'budget_recurring', existing.id, f);
    const today = requestToday(ctx, req);
    generateDue(db, req.family.id, today, ctx.time.tz(req));
    const bill = billForMonth(req, existing.id, parseMonth(req.query.month ?? req.body?.month, monthOf(today)), today);
    emitRow(req, 'bill.updated', bill);
    res.json(bill);
  });

  r.delete('/recurring/:id', (req, res) => {
    requireManager(req, 'delete bills');
    const existing = loadBill(db, req, toId(req.params.id));
    // Past payments stay in the transaction history (recurring_id is set to NULL by the FK).
    db.prepare('DELETE FROM budget_recurring WHERE id = ?').run(existing.id);
    emitRow(req, 'bill.deleted', { id: existing.id }, existing);
    res.json({ ok: true });
  });

  r.post('/recurring/:id/pay', (req, res) => {
    requireManager(req, 'mark bills paid');
    const bill = loadBill(db, req, toId(req.params.id));
    const body = req.body ?? {};
    const today = requestToday(ctx, req);
    const month = parseMonth(body.month, monthOf(today));
    const current = billsForMonth(db, req.family.id, month, today, req).find((b) => b.id === bill.id);
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
      // (loadBill opened the name; a non-family bill's payment stores it sealed again.)
      return recordBillPayment(db, bill, month, { amountCents, date, userId: req.user.id, paidBy, description: sealsBill(bill) ? ctx.box.seal(bill.description) : bill.description });
    });
    const out = billForMonth(req, bill.id, month);
    emitRow(req, 'bill.paid', out);
    emitRow(req, 'transaction.created', txJson(loadTx(db, req, txId), req));
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'budget', verb: 'paid', entityId: bill.id,
      summary: `${bill.kind === 'income' ? 'recorded' : 'paid'} ${sealsBill(bill) ? 'a bill' : bill.description} · ${money(amountCents, req.family.currency)}`,
      link: `/budget/bills?month=${month}`, audience: audienceOf(db, req.family.id, bill.visibility, bill.created_by),
    });
    checkOverBudget(ctx, req, bill.category_id, monthOf(date), before);
    res.json(out);
  });

  /**
   * A month's payment is taken back: a payment recorded for the bill is deleted (undo-able), but an
   * imported statement row that was linked to it is only unlinked — it stays in its import.
   */
  const releasePayment = (run) => {
    const t = db.prepare('SELECT id, import_id FROM budget_transactions WHERE id = ?').get(run.transaction_id);
    if (!t) return;
    if (t.import_id) db.prepare('UPDATE budget_transactions SET recurring_id = NULL WHERE id = ? AND recurring_id = ?').run(t.id, run.recurring_id);
    else db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE id = ? AND deleted_at IS NULL`).run(t.id);
  };

  r.post('/recurring/:id/skip', (req, res) => {
    requireManager(req, 'skip bills');
    const bill = loadBill(db, req, toId(req.params.id));
    const month = parseMonth(req.body?.month, monthOf(requestToday(ctx, req)));
    ctx.tx(db, () => {
      const run = db.prepare('SELECT * FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').get(bill.id, month);
      if (run?.transaction_id) releasePayment(run);
      db.prepare(
        `INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id) VALUES (?, ?, ?, 'skipped', NULL)
         ON CONFLICT(recurring_id, month) DO UPDATE SET status = 'skipped', transaction_id = NULL`,
      ).run(bill.id, req.family.id, month);
    });
    const out = billForMonth(req, bill.id, month);
    emitRow(req, 'bill.updated', out);
    emitRow(req, 'transaction.deleted', { recurring_id: bill.id }, bill);
    res.json(out);
  });

  /** Undo "paid"/"skipped" for a month: removes the payment transaction and the run. */
  r.delete('/recurring/:id/runs/:month', (req, res) => {
    requireManager(req, 'change bills');
    const bill = loadBill(db, req, toId(req.params.id));
    const month = parseMonth(req.params.month);
    ctx.tx(db, () => {
      const run = db.prepare('SELECT * FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').get(bill.id, month);
      if (!run) throw httpError(404, 'Nothing recorded for that month');
      if (run.transaction_id) releasePayment(run);
      db.prepare('DELETE FROM budget_recurring_runs WHERE recurring_id = ? AND month = ?').run(bill.id, month);
      // An auto bill already due (for this member or for the family's sweep) would be re-created by the
      // next sweep, so undoing its payment means "skipped".
      const due = dueDate(month, bill.day_of_month);
      if (bill.auto_create && run.status === 'paid' && (due <= requestToday(ctx, req) || due <= familyToday(ctx, req.family.id))) {
        db.prepare(`INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status) VALUES (?, ?, ?, 'skipped')`).run(bill.id, req.family.id, month);
      }
    });
    const out = billForMonth(req, bill.id, month);
    emitRow(req, 'bill.updated', out);
    emitRow(req, 'transaction.deleted', { recurring_id: bill.id }, bill);
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
    if (!existing || has('auto_monthly')) out.auto_monthly = body.auto_monthly ? 1 : 0;
    // The monthly amount is spread over the months until the target date, so it needs one.
    const date = out.target_date !== undefined ? out.target_date : existing?.target_date;
    if (!date && (out.auto_monthly ?? existing?.auto_monthly)) throw httpError(400, 'Set a target date to contribute automatically each month');
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
        .prepare('INSERT INTO budget_goals (family_id, name, emoji, color, target_cents, owner_id, target_date, auto_monthly, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.family.id, f.name, f.emoji, f.color, f.target_cents, f.owner_id, f.target_date, f.auto_monthly, req.user.id);
      if (initial) {
        db.prepare("INSERT INTO budget_goal_entries (goal_id, family_id, amount_cents, note, source, user_id) VALUES (?, ?, ?, 'Starting balance', 'manual', ?)")
          .run(lastInsertRowid, req.family.id, initial, req.user.id);
        if (initial >= f.target_cents) db.prepare(`UPDATE budget_goals SET completed_at = ${ISO_NOW} WHERE id = ?`).run(lastInsertRowid);
      }
      return Number(lastInsertRowid);
    });
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
    // This month's automatic contribution is made right away (later months: the sweep on the 1st).
    if (f.auto_monthly) autoContribute(ctx, req.family.id, familyToday(ctx, req.family.id), { goalId: id, req });
    const goal = goalOut(db, loadGoal(db, req.family.id, id), { entries: true });
    emit(req, 'goal.created', goal);
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
    // Switching it on makes this month's contribution right away (if the month isn't claimed yet).
    if (f.auto_monthly && !existing.auto_monthly) autoContribute(ctx, req.family.id, familyToday(ctx, req.family.id), { goalId: existing.id, req });
    const goal = goalOut(db, loadGoal(db, req.family.id, existing.id), { entries: true });
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

  r.post('/goals/:id/entries', (req, res) => {
    const goal = loadGoal(db, req.family.id, toId(req.params.id));
    const cents = toCents(req.body?.amount, { allowNegative: true });
    if (!canEditGoal(req, goal)) throw httpError(403, 'You can only add to your own goals');
    const note = cleanStr(req.body?.note, { field: 'Note', max: 140 });
    const { reached } = ctx.tx(db, () => addEntry(db, req, goal, cents, note, 'manual'));
    res.status(201).json(afterEntry(ctx, req, goal, cents, reached));
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
      if (goal) reached = addEntry(db, req, goal, allowance.amount_cents, `${allowance.frequency === 'weekly' ? 'Weekly' : 'Monthly'} allowance`, 'allowance').reached;
      db.prepare(`UPDATE budget_allowances SET last_paid_at = ${ISO_NOW} WHERE id = ?`).run(allowance.id);
    });
    const row = allowanceOut(db.prepare('SELECT * FROM budget_allowances WHERE id = ?').get(allowance.id));
    emit(req, 'allowance.paid', row);
    if (txId) emit(req, 'transaction.created', txJson(loadTx(db, req, txId), req));
    if (goal) afterEntry(ctx, req, goal, 0, reached);
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

  // ---- bank statement import -------------------------------------------------------------------
  // Upload → preview (parsed in a worker, kept in memory) → commit the rows the person kept → undo.
  // Grown-ups only. Imports are 'adults' (all grown-ups) or 'private' (only the importer).

  const sealedMatches = (req, q) => sealedMatchIds(ctx, req, q);

  // The statement stays in memory (multer memory storage, this route only) and never touches the disk.
  const statementUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
  }).single('file');

  // ponytail: previews live in this process's memory (lost on restart; one server process only).
  const PREVIEW_TTL = 15 * 60_000;
  const previews = new Map();
  const prunePreviews = () => {
    for (const [k, p] of previews) if (p.expires <= Date.now()) previews.delete(k);
  };
  const savePreview = (req, data) => {
    prunePreviews();
    const mine = [...previews].filter(([, p]) => p.userId === req.user.id).sort((a, b) => a[1].expires - b[1].expires);
    while (mine.length >= 3) previews.delete(mine.shift()[0]); // at most 3 open previews per person
    if (previews.size >= 200) previews.delete(previews.keys().next().value);
    const token = crypto.randomBytes(18).toString('base64url');
    const p = { ...data, token, userId: req.user.id, familyId: req.family.id, expires: Date.now() + PREVIEW_TTL };
    previews.set(token, p);
    return p;
  };
  /** The requester's own unexpired preview, or null. */
  const getPreview = (req) => {
    prunePreviews();
    const p = previews.get(String(req.params.token));
    return p && p.userId === req.user.id && p.familyId === req.family.id ? p : null;
  };

  const BANK_NAMES = { dbs: 'DBS', posb: 'POSB', uob: 'UOB' };
  const importOut = (i) => ({
    id: i.id, bank: i.bank, account_label: i.account_label, period_from: i.period_from, period_to: i.period_to, row_count: i.row_count,
    visibility: i.visibility, created_by: i.created_by, created_at: i.created_at,
    total_income: fromCents(i.income_cents), total_spending: fromCents(i.spending_cents),
  });

  /**
   * Learned merchant → category choices the requester may see — the grown-ups' ones and their own
   * private ones — as Map 'kind|KEY' → { id, category_id }. With `scope` only that scope's rules
   * ('adults', or 'private' = theirs); otherwise their private rule wins over the shared one.
   * ponytail: ≤ 2000 per family, matched in JS (merchant keys are sealed).
   */
  const loadRules = (req, scope = null) => {
    const out = new Map();
    const rows = db.prepare(
      `SELECT id, kind, merchant, category_id, visibility FROM budget_merchant_rules
       WHERE family_id = ? AND (visibility = 'adults' OR created_by = ?) ORDER BY visibility = 'private', id LIMIT 2000`,
    ).all(req.family.id, req.user.id);
    for (const r of rows) {
      if (scope && r.visibility !== scope) continue;
      try {
        out.set(`${r.kind}|${ctx.box.open(r.merchant)}`, { id: r.id, category_id: r.category_id });
      } catch { /* unreadable with this key: ignore */ }
    }
    return out;
  };

  /** Transactions (opened) the requester can see in [from, to]. */
  const visibleTx = (req, from, to) => db
    .prepare(
      `SELECT t.id, t.kind, t.amount_cents, t.date, t.description, t.import_id, t.recurring_id, t.transfer, t.created_by, t.visibility,
         i.account_last4, i.account_label, rb.description AS bill_description
       FROM budget_transactions t LEFT JOIN budget_imports i ON i.id = t.import_id
       LEFT JOIN budget_recurring rb ON rb.id = t.recurring_id AND ${visibleSql(req, 'rb')}
       WHERE t.family_id = ? AND t.deleted_at IS NULL AND ${visibleSql(req)} AND t.date BETWEEN ? AND ? LIMIT 20000`,
    )
    .all(req.family.id, from, to)
    .map((t) => openTx(ctx.box, t));

  /**
   * Flags rows already in the budget (same account + date + amount + merchant as an earlier
   * import; manual rows: same date + amount + merchant) or repeated within the file (same line
   * twice, unless their running balances tell them apart). Only rows the importer can see count.
   */
  // Against the budget the merchant key is compared (the CSV and PDF of one account word lines differently).
  const dupKey = (d) => merchantKey(d) || normDesc(d);
  const shiftDate = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
  const dayGap = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5;
  /** Merchant keys naming the same payee: equal, the same first word (≥ 3 letters), or one's words all in the other. */
  const sameMerchant = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const [A, B] = [a.split(' '), b.split(' ')];
    return (A[0] === B[0] && A[0].length >= 3) || A.every((w) => B.includes(w)) || B.every((w) => A.includes(w));
  };
  const TRANSFER_WORD = /\b(?:TRANSFER|TRF|FAST|PAYNOW|IBG)\b|\bGIRO\b.*\b(?:TO|FROM) OWN\b|\bOWN ACCOUNT\b|\b(?:TO|FROM) A\/C\b/i;
  const OWN_TRANSFER = /\b(?:(?:TO|FROM) OWN|OWN (?:A\/C|ACCOUNT|ACCT|DBS|POSB|UOB)|BETWEEN (?:MY|OWN) ACCOUNTS)\b/i;

  /**
   * Flags rows already in the budget: an earlier import of the same account with the same date,
   * amount and merchant; or a manual row (a bill payment marked paid by hand, say) of the same kind
   * and amount within 4 days, for the same merchant or bill — banks post a few days after the due
   * day; each manual row absorbs one statement line. Within the file, an identical line unless the
   * running balances tell them apart. Also pre-flags transfers between the family's own accounts
   * ("TO OWN ACCOUNT", or the opposite amount in another imported account within 3 days).
   * Only rows the importer can see count.
   */
  const markDuplicates = (req, rows, last4) => {
    const dates = rows.map((r) => r.date).sort();
    const known = new Set();
    const manual = [];
    const others = [];
    for (const t of visibleTx(req, shiftDate(dates[0], -4), shiftDate(dates[dates.length - 1], 4))) {
      if (t.import_id) {
        known.add(`${t.account_last4 ?? ''}|${t.date}|${t.kind}|${t.amount_cents}|${dupKey(t.description)}`);
        // Transfer pairs: only the importer's own imported rows (it may flag the other side).
        if ((t.account_last4 ?? '') !== (last4 ?? '') && t.created_by === req.user.id) others.push(t);
      } else manual.push({ ...t, keys: [merchantKey(t.description), merchantKey(t.bill_description)].filter(Boolean), used: false });
    }
    const seen = new Map();
    for (const r of rows) {
      const base = `${r.date}|${r.kind}|${r.amount_cents}|${normDesc(r.description)}`;
      const inFile = seen.has(base) && (seen.get(base) == null || r.balance_cents == null || seen.get(base) === r.balance_cents);
      seen.set(base, r.balance_cents);
      let dup = inFile || known.has(`${last4 ?? ''}|${r.date}|${r.kind}|${r.amount_cents}|${dupKey(r.description)}`);
      if (!dup) {
        const m = manual.find((t) => !t.used && t.kind === r.kind && t.amount_cents === r.amount_cents && dayGap(t.date, r.date) <= 4
          && (dupKey(t.description) === dupKey(r.description) || t.keys.some((k) => sameMerchant(k, r.key))));
        if (m) { m.used = true; dup = true; }
      }
      r.duplicate = dup;
      // The other side of a transfer: opposite amount in another of the importer's accounts within 3 days,
      // with a transfer-like word on at least one side.
      // Best candidate: one that itself looks like a transfer, then the closest date.
      const pair = others.filter((t) => t.kind !== r.kind && !t.transfer && t.amount_cents === r.amount_cents && dayGap(t.date, r.date) <= 3
        && (TRANSFER_WORD.test(r.description) || TRANSFER_WORD.test(t.description)))
        .sort((a, b) => TRANSFER_WORD.test(b.description) - TRANSFER_WORD.test(a.description) || dayGap(a.date, r.date) - dayGap(b.date, r.date))[0];
      r.transfer_pair = pair?.id ?? null;
      r.pair = pair ? { account_label: pair.account_label, date: pair.date, amount: fromCents(pair.kind === 'income' ? pair.amount_cents : -pair.amount_cents), description: pair.description } : null;
      if (r.transfer === undefined) r.transfer = OWN_TRANSFER.test(r.description) || !!pair;
    }
  };

  /** Monthly payments in the statement (with up to 7 earlier months of visible transactions), matched to existing bills. */
  const recurringFor = (req, rows, period) => {
    const hist = visibleTx(req, monthStart(addMonths(monthOf(period.to), -7)), period.to);
    const items = [
      ...rows.filter((r) => !r.duplicate && !r.transfer).map((r) => ({ key: r.key, kind: r.kind, amount_cents: r.amount_cents, date: r.date, ref: r.row_id, statement: true })),
      // History: only the importer's own rows (an import never attaches other members' rows to a bill).
      ...hist.filter((t) => !t.transfer && t.created_by === req.user.id)
        .map((t) => ({ key: merchantKey(t.description), kind: t.kind, amount_cents: t.amount_cents, date: t.date, ref: `t${t.id}`, statement: false })),
    ];
    const bills = db.prepare(`${BILL_SELECT} WHERE b.family_id = ? AND b.active = 1 AND ${visibleSql(req, 'b')}`).all(req.family.id).map((b) => openBill(db, b));
    const byId = new Map(rows.map((r) => [r.row_id, r]));
    return detectRecurring(items).slice(0, 30).map((g, i) => {
      const group = `g${i + 1}`;
      for (const ref of g.refs) if (byId.has(ref)) byId.get(ref).recurring_group = group;
      const first = g.key.split(' ')[0];
      const bill = bills.find((b) => {
        const k = merchantKey(b.description);
        return b.kind === g.kind && k && (k === g.key || (k.split(' ')[0] === first && Math.abs(b.amount_cents - g.amount_cents) <= g.amount_cents * 0.15));
      });
      return {
        group, merchant: prettyMerchant(g.key), description: prettyMerchant(g.key), amount_cents: g.amount_cents, kind: g.kind,
        day_of_month: g.day_of_month, months_seen: g.months_seen, category_id: byId.get(g.latest.ref)?.category_id ?? null,
        existing_bill_id: bill?.id ?? null, latest: g.latest, refs: g.refs,
      };
    });
  };

  const previewOut = (p) => {
    const kept = p.rows.filter((r) => !r.duplicate);
    const sum = (kind) => fromCents(kept.filter((r) => r.kind === kind && !r.transfer).reduce((s, r) => s + r.amount_cents, 0));
    return {
      token: p.token, expires_at: new Date(p.expires).toISOString(), bank: p.bank, format: p.format,
      account: p.last4 ? { label: p.label, last4: p.last4 } : null, currency: 'SGD', period: p.period,
      opening_balance: fromCents(p.opening), closing_balance: fromCents(p.closing),
      rows: p.rows.map((r) => ({
        row_id: r.row_id, date: r.date, description: r.description, merchant: prettyMerchant(r.key), amount: fromCents(r.amount_cents), kind: r.kind,
        balance: fromCents(r.balance_cents),
        category_id: r.category_id, category_source: r.category_source, duplicate: r.duplicate, recurring_group: r.recurring_group,
        transfer: !!r.transfer, pair: r.pair ?? null,
      })),
      recurring: p.recurring.map((g) => ({
        group: g.group, merchant: g.merchant, description: g.description, amount: fromCents(g.amount_cents), kind: g.kind,
        day_of_month: g.day_of_month, months_seen: g.months_seen, category_id: g.category_id, existing_bill_id: g.existing_bill_id,
      })),
      summary: { count: p.rows.length, income: sum('income'), spending: sum('expense'), duplicates: p.rows.length - kept.length },
      warnings: p.warnings,
    };
  };

  r.post(
    '/imports/preview',
    (req, res, next) => { requireManager(req, 'import bank statements'); next(); },
    ctx.rateLimit('import-user', (req) => String(req.user.id)),
    (req, res, next) => statementUpload(req, res, (err) => {
      if (!err) return next();
      const big = err.code === 'LIMIT_FILE_SIZE';
      res.status(400).json({ error: big ? MESSAGES.TOO_LARGE : 'Upload one statement file at a time', code: big ? 'TOO_LARGE' : 'UNSUPPORTED' });
    }),
    async (req, res) => {
      const file = req.file;
      // The password is used once, in the worker, and never stored or logged.
      const password = typeof req.body?.password === 'string' && req.body.password ? req.body.password : null;
      if (req.body) delete req.body.password;
      if (!file?.buffer?.length) return res.status(400).json({ error: 'Choose a statement file to import', code: 'EMPTY' });
      let parsed;
      try {
        parsed = await parseInWorker(file.buffer, { password, filename: file.originalname, owner: req.user.id });
      } catch (err) {
        if (err instanceof ImportError) return res.status(err.code === 'BUSY' ? 429 : 400).json({ error: err.message, code: err.code });
        throw err;
      } finally {
        file.buffer = null;
      }
      prepare(req);
      const cats = db.prepare('SELECT id, name, kind FROM budget_categories WHERE family_id = ?').all(req.family.id);
      const rules = loadRules(req);
      const rows = parsed.rows.map((x, i) => {
        const description = maskDigits(x.description) || (x.kind === 'income' ? 'Deposit' : 'Withdrawal');
        const key = merchantKey(description);
        const learned = key ? rules.get(`${x.kind}|${key}`) : null;
        const rule = ruleCategory(description, x.kind, cats);
        return {
          row_id: `r${i + 1}`, date: x.date, description, amount_cents: x.amount_cents, kind: x.kind, balance_cents: x.balance_cents ?? null, key,
          category_id: learned ? learned.category_id : rule, category_source: learned ? 'learned' : rule ? 'rule' : 'none', duplicate: false, recurring_group: null,
        };
      });
      markDuplicates(req, rows, parsed.last4);
      const recurring = recurringFor(req, rows, parsed.period);
      const p = savePreview(req, {
        bank: parsed.bank, format: parsed.format, last4: parsed.last4, label: `${BANK_NAMES[parsed.bank]}${parsed.last4 ? ` ••${parsed.last4}` : ''}`,
        period: parsed.period, opening: parsed.opening ?? null, closing: parsed.closing ?? null, rows, recurring, warnings: parsed.warnings ?? [],
      });
      res.json(previewOut(p));
    },
  );

  r.post('/imports/:token/commit', (req, res) => {
    requireManager(req, 'import bank statements');
    const p = getPreview(req);
    if (!p) return res.status(410).json({ error: 'This preview expired — upload the statement again', code: 'EXPIRED' });
    const fam = req.family.id;
    const body = req.body ?? {};
    const visibility = body.visibility ?? 'adults';
    if (!['adults', 'private'].includes(visibility)) throw httpError(400, 'Visibility must be adults or private');
    if (body.rows !== undefined && (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS)) throw httpError(400, 'rows must be a list');
    if (body.bills !== undefined && (!Array.isArray(body.bills) || body.bills.length > 50)) throw httpError(400, 'bills must be a list');
    const byId = new Map(p.rows.map((x) => [x.row_id, x]));
    const choices = new Map();
    for (const c of body.rows ?? []) {
      if (!c || typeof c.row_id !== 'string' || !byId.has(c.row_id)) throw httpError(400, 'Unknown row in this import');
      if (c.include !== undefined && typeof c.include !== 'boolean') throw httpError(400, 'include must be true or false');
      if (c.transfer !== undefined && typeof c.transfer !== 'boolean') throw httpError(400, 'transfer must be true or false');
      if (c.pair !== undefined && c.pair !== false) throw httpError(400, 'pair can only be false (leave the other row as it is)');
      choices.set(c.row_id, c);
    }
    const catOf = (raw, kind) => {
      if (raw === null || raw === undefined || raw === '') return null;
      const cat = getCategory(db, fam, toId(raw, 'category'));
      if (cat.kind !== kind) throw httpError(400, `${cat.name} is an ${cat.kind} category`);
      return cat.id;
    };
    // Re-check duplicates now: another import may have landed since the preview.
    const rows = p.rows.map((x) => ({ ...x }));
    markDuplicates(req, rows, p.last4);
    const catIds = new Set(db.prepare('SELECT id FROM budget_categories WHERE family_id = ?').all(fam).map((c) => c.id));
    for (const x of rows) if (x.category_id && !catIds.has(x.category_id)) x.category_id = null; // deleted since the preview
    const create = [];
    let skipped = 0;
    let excluded = 0;
    for (const x of rows) {
      const c = choices.get(x.row_id);
      x.suggested = x.category_id; // what the preview proposed (learned or built-in)
      if (c && Object.prototype.hasOwnProperty.call(c, 'category_id')) x.category_id = catOf(c.category_id, x.kind);
      if (typeof c?.transfer === 'boolean') x.transfer = c.transfer;
      if (c?.pair === false) x.transfer_pair = null;
      if (x.duplicate && c?.include !== true) { skipped++; continue; } // duplicates only when ticked explicitly
      if (c?.include === false) { excluded++; continue; }
      create.push(x);
    }
    const billReqs = [];
    const groups = new Set();
    for (const b of body.bills ?? []) {
      const g = p.recurring.find((x) => x.group === b?.group);
      if (!g || groups.has(g.group)) throw httpError(400, 'Unknown bill suggestion in this import');
      groups.add(g.group);
      billReqs.push({ b, g });
    }
    if (!create.length) return res.status(400).json({ error: 'Nothing to import — every row is a duplicate or unticked', code: 'EMPTY' });

    const sum = (kind) => create.filter((x) => x.kind === kind && !x.transfer).reduce((s, x) => s + x.amount_cents, 0);
    const bills = db.prepare(`${BILL_SELECT} WHERE b.family_id = ? AND b.active = 1 AND ${visibleSql(req, 'b')}`).all(fam).map((b) => openBill(db, b));
    /**
     * Record transaction `txId` as the payment of bill `bill` for its month — unless that month is
     * already paid (by a live transaction) or skipped. Only the importer's own rows, and only where
     * canLinkPayment allows it. The run remembers the import, so undoing it unlinks again.
     */
    const linkPayment = (bill, txId, importId) => {
      const t = txId && db.prepare('SELECT id, date, recurring_id, visibility, created_by FROM budget_transactions WHERE id = ? AND family_id = ? AND deleted_at IS NULL').get(txId, fam);
      if (!t || t.recurring_id || t.created_by !== req.user.id || !canLinkPayment(t, bill)) return;
      const month = monthOf(t.date);
      const run = db.prepare(`SELECT r.status, x.id AS live FROM budget_recurring_runs r
        LEFT JOIN budget_transactions x ON x.id = r.transaction_id AND x.deleted_at IS NULL WHERE r.recurring_id = ? AND r.month = ?`).get(bill.id, month);
      if (run && (run.status === 'skipped' || run.live)) return;
      db.prepare('UPDATE budget_transactions SET recurring_id = ? WHERE id = ?').run(bill.id, t.id);
      db.prepare(`INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id, import_id) VALUES (?, ?, ?, 'paid', ?, ?)
        ON CONFLICT(recurring_id, month) DO UPDATE SET status = 'paid', transaction_id = excluded.transaction_id, import_id = excluded.import_id`)
        .run(bill.id, fam, month, t.id, importId);
    };
    /** The existing bill a statement line pays: its group's match, else same merchant, amount ± 10%, due day ± 5. */
    const billOf = (x) => {
      const g = x.recurring_group && p.recurring.find((r) => r.group === x.recurring_group);
      if (g?.existing_bill_id) return bills.find((b) => b.id === g.existing_bill_id);
      return bills.find((b) => b.kind === x.kind && sameMerchant(merchantKey(b.description), x.key)
        && Math.abs(b.amount_cents - x.amount_cents) <= b.amount_cents * 0.1
        && Math.abs(Number(x.date.slice(8, 10)) - Math.min(b.day_of_month, 28)) <= 5);
    };
    const seal = (cents) => (cents == null ? null : ctx.box.seal(String(cents)));
    const ids = new Map();
    let billsCreated = 0;
    const importId = ctx.tx(db, () => {
      const id = Number(db.prepare(
        `INSERT INTO budget_imports (family_id, bank, format, account_label, account_last4, period_from, period_to, row_count, visibility,
           opening_balance, closing_balance, income_cents, spending_cents, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(fam, p.bank, p.format, p.label, p.last4, p.period.from, p.period.to, create.length, visibility, seal(p.opening), seal(p.closing),
        sum('income'), sum('expense'), req.user.id).lastInsertRowid);
      const insert = db.prepare(
        `INSERT INTO budget_transactions (family_id, kind, amount_cents, category_id, description, date, paid_by, created_by, visibility, import_id, balance, transfer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const x of create) {
        ids.set(x.row_id, Number(insert.run(fam, x.kind, x.amount_cents, x.category_id, ctx.box.seal(maskDigits(x.description)), x.date,
          req.user.id, req.user.id, visibility, id, seal(x.balance_cents), x.transfer ? 1 : 0).lastInsertRowid));
        // The other side of a transfer between two of the family's imported accounts.
        if (x.transfer && x.transfer_pair) db.prepare('UPDATE budget_transactions SET transfer = 1, transfer_by_import = ? WHERE id = ? AND family_id = ? AND import_id IS NOT NULL AND created_by = ? AND transfer = 0')
          .run(id, x.transfer_pair, fam, req.user.id);
      }
      // Statement lines that pay a bill already in the budget mark that month paid.
      for (const x of create) {
        const bill = !x.transfer && billOf(x);
        if (bill) linkPayment(bill, ids.get(x.row_id), id);
      }
      // Learn from the final choices (a learned rule wins over the built-in ones next time), seen by
      // the same people as this import: the grown-ups, or only the importer for a private import.
      const rules = loadRules(req, visibility);
      const total = db.prepare('SELECT COUNT(*) AS n FROM budget_merchant_rules WHERE family_id = ?').get(fam).n;
      let added = 0;
      for (const x of create) {
        if (!x.key || !x.category_id) continue;
        const k = `${x.kind}|${x.key}`;
        const rule = rules.get(k);
        if (rule) {
          if (rule.category_id !== x.category_id) {
            db.prepare(`UPDATE budget_merchant_rules SET category_id = ?, import_id = ?, updated_at = ${ISO_NOW} WHERE id = ?`).run(x.category_id, id, rule.id);
          }
          rule.category_id = x.category_id;
        } else if (x.category_id !== x.suggested && total + added < 2000) {
          const ruleId = Number(db.prepare('INSERT INTO budget_merchant_rules (family_id, kind, merchant, category_id, created_by, visibility, import_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(fam, x.kind, ctx.box.seal(x.key), x.category_id, req.user.id, visibility, id).lastInsertRowid);
          rules.set(k, { id: ruleId, category_id: x.category_id });
          added++;
        }
      }
      // Suggested bills the person accepted (manual "mark paid" bills: no auto-created duplicates).
      for (const { b, g } of billReqs) {
        if (g.existing_bill_id && db.prepare(`SELECT 1 FROM budget_recurring b WHERE id = ? AND family_id = ? AND ${visibleSql(req, 'b')}`).get(g.existing_bill_id, fam)) continue;
        // It starts the month after its latest payment (that one and the earlier ones are linked as paid).
        const f = parseBillBody(db, req, {
          kind: g.kind, description: b.description ?? g.description, amount: b.amount ?? fromCents(g.amount_cents), day_of_month: b.day_of_month ?? g.day_of_month,
          category_id: b.category_id !== undefined ? b.category_id : g.category_id, auto_create: false, start_month: addMonths(monthOf(g.latest.date), 1),
        });
        const billId = Number(db.prepare(
          `INSERT INTO budget_recurring (family_id, kind, description, amount_cents, category_id, day_of_month, auto_create, start_month, created_by, visibility, import_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        ).run(fam, f.kind, ctx.box.seal(maskDigits(f.description)), f.amount_cents, f.category_id, f.day_of_month, f.start_month, req.user.id, visibility, id).lastInsertRowid);
        billsCreated++;
        // Its payments seen in the statement (and already in the budget) mark those months paid.
        for (const ref of g.refs) linkPayment({ id: billId, visibility, created_by: req.user.id }, ref.startsWith('t') ? Number(ref.slice(1)) : ids.get(ref), id);
      }
      return id;
    });
    previews.delete(p.token);
    const out = importOut(db.prepare('SELECT * FROM budget_imports WHERE id = ?').get(importId));
    const audience = audienceOf(db, fam, visibility, req.user.id);
    // One Wall entry, only for the people who can see the import; never amounts of single lines.
    ctx.logActivity({
      familyId: fam, userId: req.user.id, module: 'budget', verb: 'imported', entityId: importId,
      summary: `imported ${create.length} transaction${create.length === 1 ? '' : 's'} from ${p.label}`,
      link: `/budget/transactions?import=${importId}`, audience,
    });
    ctx.sendToUsers(audience, 'budget.import.created', out, fam);
    ctx.sendToUsers(audience, 'budget.transaction.created', { ids: [...ids.values()], import_id: importId }, fam);
    if (billsCreated) ctx.sendToUsers(audience, 'budget.bill.created', { import_id: importId }, fam);
    res.status(201).json({ import: out, created: create.length, skipped_duplicates: skipped, excluded, bills_created: billsCreated });
  });

  r.get('/imports', (req, res) => {
    requireManager(req, 'see bank imports');
    res.json(db.prepare(`SELECT * FROM budget_imports i WHERE family_id = ? AND deleted_at IS NULL AND ${visibleSql(req, 'i')} ORDER BY created_at DESC, id DESC LIMIT 200`)
      .all(req.family.id).map(importOut));
  });

  /** Undo an import: its transactions are soft-deleted (purged with other deletions after 2 days); bills it created stay. */
  r.delete('/imports/:id', (req, res) => {
    requireManager(req, 'undo imports');
    const imp = db.prepare(`SELECT * FROM budget_imports i WHERE id = ? AND family_id = ? AND deleted_at IS NULL AND ${visibleSql(req, 'i')}`).get(toId(req.params.id), req.family.id);
    if (!imp) throw httpError(404, 'Import not found');
    const removed = ctx.tx(db, () => {
      db.prepare(`UPDATE budget_imports SET deleted_at = ${ISO_NOW} WHERE id = ?`).run(imp.id);
      db.prepare('DELETE FROM budget_merchant_rules WHERE family_id = ? AND import_id = ?').run(req.family.id, imp.id); // rules it set last
      // The other sides of transfers it flagged count again.
      db.prepare('UPDATE budget_transactions SET transfer = 0, transfer_by_import = NULL WHERE family_id = ? AND transfer_by_import = ?').run(req.family.id, imp.id);
      // Bill months it marked paid go back to unpaid, and rows it linked to bills (its own and earlier
      // ones) are unlinked; the bills themselves stay.
      for (const run of db.prepare(`SELECT recurring_id, transaction_id FROM budget_recurring_runs
        WHERE family_id = ? AND (import_id = ? OR transaction_id IN (SELECT id FROM budget_transactions WHERE import_id = ?))`).all(req.family.id, imp.id, imp.id)) {
        db.prepare('UPDATE budget_transactions SET recurring_id = NULL WHERE id = ? AND recurring_id = ?').run(run.transaction_id, run.recurring_id);
      }
      db.prepare(`DELETE FROM budget_recurring_runs WHERE family_id = ? AND (import_id = ? OR transaction_id IN (SELECT id FROM budget_transactions WHERE import_id = ?))`)
        .run(req.family.id, imp.id, imp.id);
      return Number(db.prepare(`UPDATE budget_transactions SET deleted_at = ${ISO_NOW} WHERE import_id = ? AND deleted_at IS NULL`).run(imp.id).changes);
    });
    const audience = audienceOf(db, req.family.id, imp.visibility, imp.created_by);
    const acts = db.prepare("SELECT id FROM activity WHERE family_id = ? AND module = 'budget' AND verb = 'imported' AND entity_id = ?").all(req.family.id, imp.id).map((a) => a.id);
    for (const id of acts) db.prepare('DELETE FROM activity WHERE id = ?').run(id);
    if (acts.length) ctx.sendToUsers(audience, 'activity.removed', { ids: acts }, req.family.id);
    ctx.sendToUsers(audience, 'budget.import.deleted', { id: imp.id }, req.family.id);
    ctx.sendToUsers(audience, 'budget.transaction.deleted', { import_id: imp.id }, req.family.id);
    res.json({ ok: true, removed });
  });

  // ---- insights --------------------------------------------------------------------------------

  const ESSENTIAL = /^(housing|utilities|health|savings|insurance|kids|taxes)$/i;

  /**
   * Money insights from every transaction the requester can see (manual + imported): the last `n`
   * full months plus the current one (partial, left out of the averages; months without any
   * transaction are left out too), categories vs their average, top merchants, spikes, bills, the
   * latest imported balances and whether the savings goals' monthly needs fit the average surplus.
   */
  const buildInsights = (req, today, n) => {
    const fam = req.family.id;
    const fmt = (c) => money(c, req.family.currency);
    const cur = monthOf(today);
    const first = addMonths(cur, -n);
    const full = Array.from({ length: n }, (_, i) => addMonths(first, i));
    const per = new Map([...full, cur].map((m) => [m, { income: 0, spending: 0, count: 0, cats: new Map(), byNow: new Map() }]));
    const dayNow = Number(today.slice(8, 10));
    const merchants = new Map();
    const rows = db.prepare(
      `SELECT t.kind, t.amount_cents, t.date, t.category_id, t.description, t.import_id FROM budget_transactions t
       WHERE t.family_id = ? AND t.deleted_at IS NULL AND t.transfer = 0 AND ${visibleSql(req)} AND t.date BETWEEN ? AND ?`,
    ).all(fam, monthStart(first), monthEnd(cur));
    for (const raw of rows) {
      const t = openTx(ctx.box, raw);
      const m = per.get(monthOf(t.date));
      m.count++;
      if (t.kind === 'income') { m.income += t.amount_cents; continue; }
      m.spending += t.amount_cents;
      m.cats.set(t.category_id ?? 0, (m.cats.get(t.category_id ?? 0) ?? 0) + t.amount_cents);
      // Spent by this day of the month (the 9th → days 1–9; a shorter month counts in full).
      if (Number(t.date.slice(8, 10)) <= Math.min(dayNow, daysInMonth(monthOf(t.date)))) m.byNow.set(t.category_id ?? 0, (m.byNow.get(t.category_id ?? 0) ?? 0) + t.amount_cents);
      const key = merchantKey(t.description);
      if (key) merchants.set(key, { total: (merchants.get(key)?.total ?? 0) + t.amount_cents, count: (merchants.get(key)?.count ?? 0) + 1 });
    }
    const withData = full.filter((m) => per.get(m).count > 0);
    const avg = (fn) => (withData.length ? Math.round(withData.reduce((s, m) => s + fn(per.get(m)), 0) / withData.length) : 0);
    const avgIncome = avg((x) => x.income);
    const avgSpending = avg((x) => x.spending);
    const avgSurplus = avgIncome - avgSpending;
    const now = per.get(cur);

    const cats = [
      ...db.prepare("SELECT id, name, icon, color FROM budget_categories WHERE family_id = ? AND kind = 'expense' ORDER BY sort, id").all(fam),
      { id: 0, name: 'Uncategorized', icon: 'circle-dashed', color: '#8D90A0' },
    ].map((c) => {
      const a = avg((x) => x.cats.get(c.id) ?? 0);
      const t = now.cats.get(c.id) ?? 0;
      // This month so far is compared with what earlier full months had spent by the same day
      // (a mortgage paid on the 1st is "usual" all month long).
      const td = avg((x) => x.byNow.get(c.id) ?? 0);
      return { ...c, a, t, td, change_pct: td ? Math.round(((t - td) / td) * 100) : null };
    }).filter((c) => c.a || c.t).sort((x, y) => y.a - x.a || y.t - x.t);
    const spikes = cats.filter((c) => c.td > 0 && c.t >= c.td * 1.3 && c.t - c.td >= 5000);

    // Latest closing balance per account; `stale` when the newest statement had none (an older one's is shown).
    const balances = [];
    const newest = new Map();
    for (const i of db.prepare(`SELECT account_label, closing_balance, period_to FROM budget_imports i WHERE family_id = ? AND deleted_at IS NULL AND ${visibleSql(req, 'i')} ORDER BY period_to DESC, id DESC`).all(fam)) {
      if (!newest.has(i.account_label)) newest.set(i.account_label, i.period_to);
      if (i.closing_balance == null || balances.some((b) => b.account_label === i.account_label)) continue;
      try {
        const balance = fromCents(Number(ctx.box.open(i.closing_balance)));
        const statementTo = newest.get(i.account_label);
        balances.push({ account_label: i.account_label, balance, as_of: i.period_to, statement_to: statementTo, stale: i.period_to !== statementTo });
      } catch { /* unreadable */ }
    }

    const bills = billsForMonth(db, fam, cur, today, req).filter((b) => b.kind === 'expense' && b.active);
    const billCents = bills.reduce((s, b) => s + Math.round(b.amount * 100), 0);

    // Goals: what the dated ones need each month (the same amount automatic contributions use).
    const goals = db.prepare(`${GOALS_SELECT} WHERE g.family_id = ? AND g.completed_at IS NULL GROUP BY g.id ORDER BY g.target_date, g.id`).all(fam);
    const items = goals.filter((g) => g.target_date && monthOf(g.target_date) >= cur).map((g) => {
      const left = Math.max(0, g.target_cents - g.saved_cents);
      // This month's automatic contribution already happened: spread the rest from next month.
      const from = g.auto_monthly && g.auto_last_month === cur && monthOf(g.target_date) > cur ? addMonths(cur, 1) : cur;
      return { g, left, from, monthly: autoAmount(left, from, g.target_date) };
    });
    const undated = goals.filter((g) => !g.target_date).length;
    const overdue = goals.filter((g) => g.target_date && monthOf(g.target_date) < cur)
      .map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, target_date: g.target_date, left: fromCents(Math.max(0, g.target_cents - g.saved_cents)) }));
    const needed = items.reduce((s, x) => s + x.monthly, 0);
    const status = !withData.length ? 'no_data' : avgSurplus >= needed ? 'on_track' : 'short';
    const shortfall = status === 'short' ? needed - avgSurplus : 0;
    const label = (g) => `${g.emoji ? `${g.emoji} ` : ''}${g.name}`;
    // Suggestions are alternatives — each one on its own — best (smallest gap left) first.
    const options = [];
    if (status === 'short') {
      const big = [...items].sort((a, b) => b.monthly - a.monthly)[0];
      for (let k = 1; big && k <= 36; k++) {
        const later = addMonths(monthOf(big.g.target_date), k);
        const m = autoAmount(big.left, big.from, dueDate(later, Number(big.g.target_date.slice(8, 10))));
        if (needed - big.monthly + m <= avgSurplus) {
          options.push({ gap: 0, text: `Move ${label(big.g)} from ${monthLabel(monthOf(big.g.target_date), 'short')} to ${monthLabel(later, 'short')} — that frees up ${fmt(big.monthly - m)} a month and closes the gap.` });
          break;
        }
      }
      for (const c of cats.filter((x) => x.id && !ESSENTIAL.test(x.name)).slice(0, 2)) {
        const cut = Math.min(shortfall, Math.round((c.a * 0.25) / 100) * 100);
        if (cut < 1000) continue;
        const gap = shortfall - cut;
        // Same comparison as spikes: this month so far against what's usual by today.
        const vs = c.td ? ` (${c.change_pct >= 0 ? '+' : ''}${c.change_pct}%)` : '';
        options.push({
          gap,
          text: `${c.name}: ${fmt(c.t)} so far — usually ${fmt(c.td)} by now${vs}. Spending ${fmt(cut)} less on ${c.name} each month would ${gap > 0 ? `leave you ${fmt(gap)} a month short.` : 'close the gap.'}`,
        });
      }
      options.sort((a, b) => a.gap - b.gap);
    }
    const tips = options.map((o) => o.text);
    if (status === 'no_data') tips.push('Add a month of transactions or import a bank statement to see whether your goals fit.');
    if (status === 'on_track') {
      tips.push(needed
        ? `Your goals need ${fmt(needed)} a month and you keep about ${fmt(avgSurplus)} — ${fmt(avgSurplus - needed)} to spare.`
        : `You keep about ${fmt(avgSurplus)} a month — give a goal a target date to plan for it.`);
    }
    const remainingGap = status === 'short' ? (options[0]?.gap ?? shortfall) : 0;

    const catOut = (c) => ({
      category_id: c.id || null, name: c.name, icon: c.icon, color: c.color, avg: fromCents(c.a), avg_to_date: fromCents(c.td), this_month: fromCents(c.t), change_pct: c.change_pct,
    });
    return {
      today,
      months: [...full, cur].map((m) => {
        const x = per.get(m);
        return { month: m, income: fromCents(x.income), spending: fromCents(x.spending), surplus: fromCents(x.income - x.spending), partial: m === cur };
      }),
      avg_income: fromCents(avgIncome), avg_spending: fromCents(avgSpending), avg_surplus: fromCents(avgSurplus), full_months: withData.length,
      balances,
      categories: cats.map(catOut),
      merchants: [...merchants].sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([k, v]) => ({ merchant: prettyMerchant(k), total: fromCents(v.total), count: v.count })),
      spikes: spikes.map((c) => ({ category_id: c.id || null, name: c.name, this_month: fromCents(c.t), avg: fromCents(c.a), usual_by_now: fromCents(c.td), change_pct: c.change_pct })),
      recurring: { total_monthly: fromCents(billCents), bills: bills.map((b) => ({ id: b.id, description: b.description, amount: b.amount })) },
      goals: {
        needed_monthly: fromCents(needed), surplus: fromCents(avgSurplus), status, shortfall: fromCents(shortfall),
        items: items.map(({ g, monthly }) => ({ id: g.id, name: g.name, emoji: g.emoji, monthly: fromCents(monthly), target_date: g.target_date, auto_monthly: !!g.auto_monthly })),
        undated, overdue, suggestions: tips.slice(0, 5), remaining_gap: fromCents(remainingGap),
      },
    };
  };

  r.get('/insights', (req, res) => {
    requireManager(req, 'see money insights');
    const today = prepare(req);
    const n = req.query.months === undefined || req.query.months === '' ? 3 : Number(req.query.months);
    if (!Number.isInteger(n) || n < 1 || n > 12) throw httpError(400, 'Months must be a whole number from 1 to 12');
    res.json(buildInsights(req, today, n));
  });

  return r;
}

// ---- hooks ----------------------------------------------------------------------------------

/**
 * Ids of sealed transactions (imported, adults-only or private) the requester can see whose
 * description or notes match `q`.
 * ponytail: decrypts the latest 5000 such rows per search; add an encrypted index if that gets slow.
 */
function sealedMatchIds(ctx, req, q) {
  return ctx.db
    .prepare(`SELECT id, description, notes FROM budget_transactions t WHERE family_id = ? AND deleted_at IS NULL
      AND (import_id IS NOT NULL OR visibility != 'family') AND ${visibleSql(req)} ORDER BY date DESC, id DESC LIMIT 5000`)
    .all(req.family.id)
    .filter((t) => {
      try {
        return searchMatch(ctx.box.open(t.description), q) || searchMatch(ctx.box.open(t.notes), q);
      } catch {
        return false;
      }
    })
    .map((t) => t.id);
}

export function search(ctx, familyId, q, req) {
  const family = ctx.db.prepare('SELECT currency FROM families WHERE id = ?').get(familyId);
  const sealed = req ? sealedMatchIds(ctx, req, q) : [];
  const txs = ctx.db
    .prepare(
      `${TX_SELECT} WHERE t.family_id = ? AND t.deleted_at IS NULL AND ${visibleSql(req)}
       AND ((t.import_id IS NULL AND t.visibility = 'family' AND (search_match(t.description, ?) OR search_match(t.notes, ?))) OR t.id IN (SELECT value FROM json_each(?)))
       ORDER BY t.date DESC LIMIT 5`,
    )
    .all(familyId, q, q, JSON.stringify(sealed))
    .map((raw) => openTx(ctx.box, raw))
    .map((row) => ({
      title: row.description || row.c_name || 'Transaction',
      subtitle: `${row.kind === 'income' ? '+' : '−'}${money(row.amount_cents, family?.currency)} · ${row.c_name ?? 'Uncategorized'} · ${row.date}`,
      link: `/budget/transactions?month=${monthOf(row.date)}&tx=${row.id}`,
    }));
  const goals = ctx.db
    .prepare("SELECT * FROM budget_goals WHERE family_id = ? AND search_match(name, ?) LIMIT 3")
    .all(familyId, q)
    .map((g) => ({ title: `${g.emoji ? `${g.emoji} ` : ''}${g.name}`, subtitle: `Savings goal · ${money(g.target_cents, family?.currency)}`, link: `/budget/goals?goal=${g.id}` }));
  // Family bills match in SQL; sealed ones (from an import) are opened and matched in JS.
  const bills = ctx.db
    .prepare(`SELECT * FROM budget_recurring b WHERE family_id = ? AND active = 1 AND ${visibleSql(req, 'b')}
      AND (visibility != 'family' OR search_match(description, ?)) ORDER BY id DESC LIMIT 500`)
    .all(familyId, q)
    .map((b) => openBill(ctx.db, { ...b, description: ctx.box.open(b.description) }))
    .filter((b) => searchMatch(b.description, q))
    .slice(0, 3)
    .map((b) => ({ title: b.description, subtitle: `Monthly bill · ${money(b.amount_cents, family?.currency)} on day ${b.day_of_month}`, link: '/budget/bills' }));
  return [...txs, ...goals, ...bills].slice(0, 8);
}

/** Someone leaving takes their private budget data with them (private imports, their rows and bills). */
export function onMemberLeft(ctx, { familyId, userId }) {
  const { db } = ctx;
  ctx.tx(db, () => {
    const imports = db.prepare("SELECT id FROM budget_imports WHERE family_id = ? AND created_by = ? AND visibility = 'private'").all(familyId, userId).map((i) => i.id);
    for (const id of imports) db.prepare("DELETE FROM activity WHERE family_id = ? AND module = 'budget' AND verb = 'imported' AND entity_id = ?").run(familyId, id);
    // Budget Wall entries only they could see ("added an expense: … · $77.00" on a private row).
    for (const a of db.prepare("SELECT id, audience FROM activity WHERE family_id = ? AND module = 'budget' AND audience IS NOT NULL").all(familyId)) {
      const ids = activityAudience(a);
      if (ids?.length && ids.every((u) => u === userId)) db.prepare('DELETE FROM activity WHERE id = ?').run(a.id);
    }
    for (const t of db.prepare("SELECT receipt_url FROM budget_transactions WHERE family_id = ? AND created_by = ? AND visibility = 'private' AND receipt_url IS NOT NULL").all(familyId, userId)) {
      ctx.removeFile(t.receipt_url);
    }
    db.prepare("DELETE FROM budget_merchant_rules WHERE family_id = ? AND created_by = ? AND visibility = 'private'").run(familyId, userId);
    db.prepare("DELETE FROM budget_transactions WHERE family_id = ? AND created_by = ? AND visibility = 'private'").run(familyId, userId);
    db.prepare("DELETE FROM budget_recurring WHERE family_id = ? AND created_by = ? AND visibility = 'private'").run(familyId, userId);
    db.prepare("DELETE FROM budget_imports WHERE family_id = ? AND created_by = ? AND visibility = 'private'").run(familyId, userId);
  });
  scrubFreedPages(db); // secure_delete zeroed the rows; flush the old pages out of the WAL too
}

export function dashboard(ctx, req) {
  const { db } = ctx;
  ensureDefaults(db, req.family.id);
  const today = requestToday(ctx, req);
  const month = monthOf(today);
  const s = buildSummary(db, req, month);
  const bills = billsForMonth(db, req.family.id, month, today, req);
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
