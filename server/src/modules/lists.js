// Lists & tasks — module "lists", mounted at /api/lists.
// Shopping lists (auto-grouped by aisle), to-do lists with assignees + due dates, and free-form
// lists. Cross-module contract (docs/ARCHITECTURE.md): `GET /api/lists?type=shopping`,
// `POST /api/lists/:id/items/bulk`, and a `dashboard` export `{ due, overdue, lists }`.
//
// "Today" is always the requesting user's local day (ctx.time.today(req), from the X-Timezone
// header); an explicit `?today=YYYY-MM-DD` query overrides it (tests / debugging). Background
// reminders use each assignee's own zone.
//
// Deleting an item is a soft delete (deleted_at) so "Undo" can restore the original row exactly
// (POST /:id/items/:itemId/restore) without re-notifying anyone. Soft-deleted rows are invisible
// everywhere and purged after a day.
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { cleanStr, httpError, isColor, isDate, toId } from '../util.js';
import { CATEGORIES, guessCategory, normalizeCategory, parseQuantity } from './lists/categories.js';
import { seedLists } from './lists/seed.js';

export { parseQuantity };
export const name = 'lists';

export const TYPES = ['shopping', 'todo', 'other'];
const DEFAULTS = {
  shopping: { icon: '🛒', color: '#30A46C' },
  todo: { icon: '✅', color: '#5B5BD6' },
  other: { icon: '📝', color: '#F76B15' },
};
const TYPE_LABEL = { shopping: 'Shopping list', todo: 'To-do list', other: 'List' };
const MAX_BULK = 200;
export const MAX_ITEMS_PER_LIST = 2000;
/** Local hour (in the assignee's zone) from which due reminders go out. */
export const REMINDER_HOUR = 8;
const PURGE_AFTER_MS = 24 * 3600_000;
const NUDGE_EVERY_MS = 5 * 60_000;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS lists (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL DEFAULT 'todo' CHECK (type IN ('shopping','todo','other')),
     icon TEXT,
     color TEXT,
     position INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW}
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lists_family ON lists(family_id, position)`,
  `CREATE TABLE IF NOT EXISTS list_items (
     id INTEGER PRIMARY KEY,
     list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     quantity TEXT,
     notes TEXT,
     category TEXT,
     assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     due_date TEXT,
     done INTEGER NOT NULL DEFAULT 0,
     done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     done_at TEXT,
     position INTEGER NOT NULL DEFAULT 0,
     reminded_on TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW}
   )`,
  `ALTER TABLE list_items ADD COLUMN deleted_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_list_items_assignee ON list_items(family_id, assignee_id, done, due_date)`,
];

// ---------------------------------------------------------------------------------------------
// Helpers

/** 'YYYY-MM-DD' + n days (pure calendar arithmetic, no time zone involved). */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** The requesting user's local day, or an explicit ?today= override. */
const todayFor = (ctx, req) => (isDate(req.query?.today) ? req.query.today : ctx.time.today(req));

const nowIso = () => new Date().toISOString();


const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function cleanIcon(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'Icon must be an emoji');
  const s = value.trim();
  if (!s) return null;
  const graphemes = segmenter ? [...segmenter.segment(s)].length : [...s].length;
  if (s.length > 16 || graphemes !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) {
    throw httpError(400, 'Icon must be a single emoji');
  }
  return s;
}

function cleanType(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!TYPES.includes(value)) throw httpError(400, 'Type must be shopping, todo or other');
  return value;
}

function cleanDue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isDate(value)) throw httpError(400, 'Due date must be a valid date (YYYY-MM-DD)');
  return value;
}

function cleanQuantity(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  return cleanStr(value, { field: 'Quantity', max: 40 });
}

function cleanCategory(value) {
  const s = cleanStr(value, { field: 'Category', max: 40 });
  return s ? normalizeCategory(s) : null;
}

const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] || 'Someone';
const quote = (s) => `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;

function dueLabel(due, today) {
  if (!due) return null;
  if (due === today) return 'due today';
  if (due < today) return 'overdue';
  if (due === addDays(today, 1)) return 'due tomorrow';
  const d = new Date(`${due}T12:00:00Z`);
  return `due ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

function hourIn(tz, now) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric' }).format(now));
  } catch {
    return now.getHours();
  }
}

// ---- debounced activity -----------------------------------------------------------------------
// Adding/checking items is bursty (a whole grocery run). Rather than one Wall entry per tap, we
// collect a user's adds / completions on a list and log ONE entry after a short quiet period
// ("added 6 items to Groceries"). Unchecking (or deleting) an item within the window cancels its
// pending entry. Pending entries live in memory; they are flushed on SIGTERM/SIGINT (before the
// server's own shutdown closes the database) and on beforeExit, so a graceful restart loses nothing.
// A hard crash can drop at most one quiet period (~12s) of batched entries — acceptable for a feed.
const pending = new Map();
export const ACTIVITY_QUIET_MS = 12_000;
const ACTIVITY_MAX_MS = 90_000;

const pendingKey = (familyId, userId, listId, kind) => `${familyId}:${userId}:${listId}:${kind}`;

function flushEntry(key) {
  const e = pending.get(key);
  if (!e) return;
  pending.delete(key);
  clearTimeout(e.timer);
  if (!e.texts.length) return;
  const n = e.texts.length;
  let summary;
  if (e.kind === 'added') {
    summary = n === 1 ? `added ${quote(e.texts[0])} to ${e.listName}` : `added ${n} items to ${e.listName}`;
  } else if (e.listType === 'shopping') {
    summary = n === 1 ? `checked off ${quote(e.texts[0])} on ${e.listName}` : `checked off ${n} items on ${e.listName}`;
  } else {
    summary = n === 1 ? `completed ${quote(e.texts[0])} in ${e.listName}` : `completed ${n} tasks in ${e.listName}`;
  }
  try {
    // The list may have been deleted meanwhile; don't point the Wall at a dead link.
    const alive = e.ctx.db.prepare('SELECT name FROM lists WHERE id = ? AND family_id = ?').get(e.listId, e.familyId);
    if (!alive) return;
    e.ctx.logActivity({
      familyId: e.familyId, userId: e.userId, module: 'lists', verb: e.kind === 'added' ? 'added' : 'completed',
      entityId: e.listId, summary, link: `/lists/${e.listId}`,
    });
  } catch {
    /* database already closed — drop the entry */
  }
}

function queueActivity(ctx, { familyId, userId, list, kind, itemId, text }) {
  const key = pendingKey(familyId, userId, list.id, kind);
  let e = pending.get(key);
  if (!e) {
    e = { ctx, familyId, userId, listId: list.id, listName: list.name, listType: list.type, kind, texts: [], ids: [], started: Date.now(), timer: null };
    pending.set(key, e);
  }
  e.listName = list.name;
  e.texts.push(text);
  e.ids.push(itemId);
  clearTimeout(e.timer);
  const wait = Math.max(0, Math.min(ACTIVITY_QUIET_MS, e.started + ACTIVITY_MAX_MS - Date.now()));
  e.timer = setTimeout(() => flushEntry(key), wait);
  e.timer.unref?.();
}

/** Drop an item from any pending batch (unchecked / deleted before the entry was logged). */
function unqueueItem({ familyId, listId, itemId, kind = null }) {
  const removed = [];
  for (const [key, e] of pending) {
    if (e.familyId !== familyId || e.listId !== listId || (kind && e.kind !== kind)) continue;
    const i = e.ids.indexOf(itemId);
    if (i < 0) continue;
    removed.push({ kind: e.kind, userId: e.userId, text: e.texts[i] });
    e.ids.splice(i, 1);
    e.texts.splice(i, 1);
    if (!e.ids.length) {
      clearTimeout(e.timer);
      pending.delete(key);
    }
  }
  return removed;
}

// Batched entries pulled out by a delete, kept briefly so an Undo (restore) can put them back.
const stashed = new Map(); // itemId -> { entries, at }
function stashRemoved(itemId, entries) {
  const cutoff = Date.now() - ACTIVITY_MAX_MS;
  for (const [k, v] of stashed) if (v.at < cutoff) stashed.delete(k);
  if (entries.length) stashed.set(itemId, { entries, at: Date.now() });
}
function takeStashed(itemId) {
  const v = stashed.get(itemId);
  stashed.delete(itemId);
  return v && v.at >= Date.now() - ACTIVITY_MAX_MS ? v.entries : [];
}

/** Log every pending (debounced) activity entry now. Used by tests and graceful shutdown. */
export function flushPendingActivity() {
  for (const key of [...pending.keys()]) flushEntry(key);
}

let shutdownHooked = false;
function hookShutdown() {
  if (shutdownHooked || typeof process === 'undefined') return;
  shutdownHooked = true;
  process.on('beforeExit', flushPendingActivity);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const onSignal = () => {
      flushPendingActivity();
      // If nobody else handles the signal (e.g. a test runner), keep the default behaviour.
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
    };
    // Registered while the app is built, i.e. before server/src/index.js adds its shutdown
    // handler, so this runs first — while the database is still open.
    process.on(sig, onSignal);
  }
}

// ---- due-date reminders -----------------------------------------------------------------------

/**
 * Notify assignees about undone tasks that are due today (or overdue) in THEIR time zone, once
 * per task, from REMINDER_HOUR local time. Runs periodically from the router; exported for tests.
 * Returns the number of notifications sent.
 */
export function sendDueReminders(ctx, now = new Date()) {
  const rows = ctx.db.prepare(
    `SELECT i.*, l.name AS list_name FROM list_items i JOIN lists l ON l.id = i.list_id
      WHERE i.done = 0 AND i.deleted_at IS NULL AND i.assignee_id IS NOT NULL AND i.due_date IS NOT NULL
        AND i.reminded_on IS NULL AND i.due_date <= ? AND l.type != 'shopping'`,
  ).all(addDays(now.toISOString().slice(0, 10), 1)); // pre-filter: no zone is more than a day ahead
  const mark = ctx.db.prepare('UPDATE list_items SET reminded_on = ? WHERE id = ?');
  let sent = 0;
  for (const it of rows) {
    const tz = ctx.time.tzOf(it.assignee_id);
    const today = ctx.time.dateIn(tz, now);
    if (it.due_date > today || hourIn(tz, now) < REMINDER_HOUR) continue;
    mark.run(today, it.id);
    const overdue = it.due_date < today;
    sent += ctx.notify({
      familyId: it.family_id, userIds: [it.assignee_id], module: 'lists',
      title: overdue ? `Overdue: ${it.text}` : `Due today: ${it.text}`,
      body: `On ${it.list_name}`,
      link: `/lists/${it.list_id}?item=${it.id}`,
    }).length;
  }
  return sent;
}

/** Permanently remove soft-deleted items older than a day. */
export function purgeDeleted(ctx, now = Date.now()) {
  return Number(ctx.db.prepare('DELETE FROM list_items WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .run(new Date(now - PURGE_AFTER_MS).toISOString()).changes);
}

// ---------------------------------------------------------------------------------------------

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const r = Router();
  hookShutdown();

  // Periodic reminders + purge (unref'd so tests/CLI can exit; stops once the db closes).
  const sweep = () => {
    try {
      sendDueReminders(ctx);
      purgeDeleted(ctx);
      return true;
    } catch (err) {
      if (!/not open|closed/i.test(err.message)) console.error('[lists] background sweep failed:', err.message);
      return false;
    }
  };
  const timer = setInterval(() => {
    if (!sweep()) clearInterval(timer);
  }, 10 * 60_000);
  timer.unref?.();
  setTimeout(sweep, 15_000).unref?.();

  const nudges = new Map(); // itemId -> last nudge ms (throttle)
  const pruneNudges = () => {
    const cutoff = Date.now() - NUDGE_EVERY_MS;
    for (const [k, t] of nudges) if (t < cutoff) nudges.delete(k);
  };

  const isMember = db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?');
  const getList = db.prepare('SELECT * FROM lists WHERE id = ? AND family_id = ?');
  const getItem = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ? AND family_id = ? AND deleted_at IS NULL');
  const getDeletedItem = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ? AND family_id = ? AND deleted_at IS NOT NULL');
  const itemById = db.prepare('SELECT * FROM list_items WHERE id = ?');
  const maxItemPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p, COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS n FROM list_items WHERE list_id = ?',
  );
  const touchList = db.prepare(`UPDATE lists SET updated_at = ${ISO_NOW} WHERE id = ?`);

  // ---- permissions ----
  // Grown-ups (admin/member) can do everything. Children can check anything off; they fully
  // manage lists/items they created; on a chore merely ASSIGNED to them they may only tick it
  // and add notes (not move the due date or rename it).
  const isChild = (req) => req.role === 'child';
  const canManageList = (req, list) => !isChild(req) || list.created_by === req.user.id;
  const editLevel = (req, list, item) => {
    if (!isChild(req) || item.created_by === req.user.id || list.created_by === req.user.id) return 'full';
    if (item.assignee_id === req.user.id) return 'notes';
    return 'none';
  };
  const canDeleteItem = (req, list, item) => !isChild(req) || item.created_by === req.user.id || list.created_by === req.user.id;

  function loadList(req) {
    const list = getList.get(toId(req.params.id), req.family.id);
    if (!list) throw httpError(404, 'List not found');
    return list;
  }
  function loadItem(req, list) {
    const item = getItem.get(toId(req.params.itemId, 'item id'), list.id, req.family.id);
    if (!item) throw httpError(404, 'Item not found');
    return item;
  }

  function checkAssignee(req, value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const id = toId(value, 'assignee');
    if (!isMember.get(req.family.id, id)) throw httpError(400, 'The assignee must be a member of this family');
    return id;
  }

  function serializeItem(row, req, list) {
    const level = editLevel(req, list, row);
    return {
      id: row.id,
      list_id: row.list_id,
      family_id: row.family_id,
      text: row.text,
      quantity: row.quantity,
      notes: row.notes,
      category: row.category,
      assignee_id: row.assignee_id,
      due_date: row.due_date,
      done: !!row.done,
      done_by: row.done_by,
      done_at: row.done_at,
      position: row.position,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      can_edit: level === 'full',
      can_edit_notes: level !== 'none',
      can_delete: canDeleteItem(req, list, row),
    };
  }

  const statsStmt = db.prepare(
    `SELECT COUNT(*) AS item_count, COALESCE(SUM(done), 0) AS done_count,
            COALESCE(SUM(CASE WHEN done = 0 AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue_count,
            COALESCE(SUM(CASE WHEN done = 0 AND due_date = ? THEN 1 ELSE 0 END), 0) AS due_today_count
       FROM list_items WHERE list_id = ? AND deleted_at IS NULL`,
  );
  const previewStmt = db.prepare(
    'SELECT text FROM list_items WHERE list_id = ? AND done = 0 AND deleted_at IS NULL ORDER BY position, id LIMIT 4',
  );
  const assigneesStmt = db.prepare(
    `SELECT DISTINCT assignee_id FROM list_items
      WHERE list_id = ? AND done = 0 AND deleted_at IS NULL AND assignee_id IS NOT NULL ORDER BY assignee_id`,
  );

  function serializeList(list, req, today = todayFor(ctx, req)) {
    const s = statsStmt.get(today, today, list.id);
    const isShopping = list.type === 'shopping';
    return {
      id: list.id,
      family_id: list.family_id,
      name: list.name,
      type: list.type,
      icon: list.icon ?? DEFAULTS[list.type].icon,
      color: list.color ?? DEFAULTS[list.type].color,
      position: list.position,
      created_by: list.created_by,
      created_at: list.created_at,
      updated_at: list.updated_at,
      item_count: Number(s.item_count),
      done_count: Number(s.done_count),
      open_count: Number(s.item_count) - Number(s.done_count),
      overdue_count: isShopping ? 0 : Number(s.overdue_count),
      due_today_count: isShopping ? 0 : Number(s.due_today_count),
      preview: previewStmt.all(list.id).map((p) => p.text),
      assignee_ids: assigneesStmt.all(list.id).map((a) => a.assignee_id),
      can_manage: canManageList(req, list),
    };
  }

  const listItemsStmt = db.prepare('SELECT * FROM list_items WHERE list_id = ? AND deleted_at IS NULL ORDER BY position, id');
  function fullList(list, req) {
    return { ...serializeList(list, req), items: listItemsStmt.all(list.id).map((i) => serializeItem(i, req, list)) };
  }

  function emit(req, type, payload) {
    ctx.broadcast(req.family.id, `lists.${type}`, { ...payload, by: req.user.id });
  }

  function notifyAssigned(req, list, item) {
    if (!item.assignee_id || item.assignee_id === req.user.id) return;
    const due = dueLabel(item.due_date, ctx.time.todayForUser(item.assignee_id));
    ctx.notify({
      familyId: req.family.id, userIds: [item.assignee_id], module: 'lists', excludeUserId: req.user.id,
      title: `${firstName(req.user.name)} assigned you a task`,
      body: `${item.text} · ${list.name}${due ? ` · ${due}` : ''}`,
      link: `/lists/${list.id}?item=${item.id}`,
    });
  }

  const insertItem = db.prepare(
    `INSERT INTO list_items (list_id, family_id, text, quantity, notes, category, assignee_id, due_date, position, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  function addItem(req, list, f, position) {
    const { lastInsertRowid } = insertItem.run(
      list.id, req.family.id, f.text, f.quantity ?? null, f.notes ?? null, f.category ?? null,
      f.assignee_id ?? null, f.due_date ?? null, position, req.user.id,
    );
    return itemById.get(lastInsertRowid);
  }

  function itemFields(req, list, body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.text !== undefined) {
      let text = cleanStr(body.text, { field: 'Item', required: true, max: 200 });
      let quantity = cleanQuantity(body.quantity);
      if (!partial && quantity === undefined && body.parse !== false) {
        const parsed = parseQuantity(text);
        text = parsed.text;
        if (parsed.quantity) quantity = parsed.quantity;
      }
      out.text = text;
      if (quantity !== undefined) out.quantity = quantity;
    } else if (body.quantity !== undefined) {
      out.quantity = cleanQuantity(body.quantity);
    }
    if (body.notes !== undefined) out.notes = cleanStr(body.notes, { field: 'Notes', max: 1000 });
    if (body.category !== undefined) out.category = cleanCategory(body.category);
    const assignee = checkAssignee(req, body.assignee_id);
    if (assignee !== undefined) out.assignee_id = assignee;
    const due = cleanDue(body.due_date);
    if (due !== undefined) out.due_date = due;
    if (!partial && list.type === 'shopping' && !out.category) out.category = guessCategory(out.text);
    return out;
  }

  function assertCanAssign(req, current, next) {
    if (!isChild(req) || next === undefined || next === null || next === req.user.id || next === current) return;
    throw httpError(403, 'Only grown-ups can assign tasks to other family members');
  }

  function assertRoom(listId, adding) {
    if (maxItemPos.get(listId).n + adding > MAX_ITEMS_PER_LIST) throw httpError(400, 'This list is full — clear some completed items first');
  }

  // ---- lists ----------------------------------------------------------------------------------

  r.get('/', (req, res) => {
    const type = req.query.type;
    if (type !== undefined && !TYPES.includes(type)) throw httpError(400, 'Type must be shopping, todo or other');
    const rows = type
      ? db.prepare('SELECT * FROM lists WHERE family_id = ? AND type = ? ORDER BY position, id').all(req.family.id, type)
      : db.prepare('SELECT * FROM lists WHERE family_id = ? ORDER BY position, id').all(req.family.id);
    const today = todayFor(ctx, req);
    res.json(rows.map((l) => serializeList(l, req, today)));
  });

  r.post('/', (req, res) => {
    const body = req.body ?? {};
    const name = cleanStr(body.name, { field: 'Name', required: true, max: 80 });
    const type = cleanType(body.type, 'todo');
    const icon = cleanIcon(body.icon) ?? DEFAULTS[type].icon;
    if (body.color != null && body.color !== '' && !isColor(body.color)) throw httpError(400, 'Color must be a hex color like #30A46C');
    const color = body.color || DEFAULTS[type].color;
    const { p } = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM lists WHERE family_id = ?').get(req.family.id);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO lists (family_id, name, type, icon, color, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.family.id, name, type, icon, color, p + 1, req.user.id);
    const list = getList.get(lastInsertRowid, req.family.id);
    const out = serializeList(list, req);
    emit(req, 'created', { list_id: list.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'created', entityId: list.id,
      summary: `created the ${type === 'shopping' ? 'shopping list' : 'list'} ${icon} ${name}`, link: `/lists/${list.id}`,
    });
    res.status(201).json(out);
  });

  // ---- "My tasks" + badge (before /:id) -------------------------------------------------------

  function tasksFor(req, userId, today) {
    const rows = db.prepare(
      `SELECT i.*, l.name AS list_name, l.icon AS list_icon, l.color AS list_color, l.type AS list_type, l.created_by AS list_created_by
         FROM list_items i JOIN lists l ON l.id = i.list_id
        WHERE i.family_id = ? AND i.assignee_id = ? AND i.done = 0 AND i.deleted_at IS NULL AND l.type != 'shopping'
        ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date, l.position, i.position, i.id`,
    ).all(req.family.id, userId);
    const groups = { overdue: [], today: [], upcoming: [], someday: [] };
    for (const row of rows) {
      const list = { id: row.list_id, created_by: row.list_created_by };
      const item = {
        ...serializeItem(row, req, list),
        list_name: row.list_name,
        list_icon: row.list_icon ?? DEFAULTS[row.list_type].icon,
        list_color: row.list_color ?? DEFAULTS[row.list_type].color,
        list_type: row.list_type,
      };
      if (!row.due_date) groups.someday.push(item);
      else if (row.due_date < today) groups.overdue.push(item);
      else if (row.due_date === today) groups.today.push(item);
      else groups.upcoming.push(item);
    }
    return groups;
  }

  r.get('/my-tasks', (req, res) => {
    const userId = req.query.user_id ? toId(req.query.user_id, 'user') : req.user.id;
    if (!isMember.get(req.family.id, userId)) throw httpError(404, 'Member not found');
    const today = todayFor(ctx, req);
    res.json({ user_id: userId, date: today, ...tasksFor(req, userId, today) });
  });

  r.get('/my-tasks/count', (req, res) => {
    const today = todayFor(ctx, req);
    const row = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN i.due_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN i.due_date = ? THEN 1 ELSE 0 END), 0) AS today,
              COUNT(*) AS open
         FROM list_items i JOIN lists l ON l.id = i.list_id
        WHERE i.family_id = ? AND i.assignee_id = ? AND i.done = 0 AND i.deleted_at IS NULL AND l.type != 'shopping'`,
    ).get(today, today, req.family.id, req.user.id);
    const overdue = Number(row.overdue);
    const dueToday = Number(row.today);
    res.json({ overdue, today: dueToday, open: Number(row.open), attention: overdue + dueToday });
  });

  r.get('/categories', (req, res) => res.json(CATEGORIES));

  // ---- single list ----------------------------------------------------------------------------

  r.get('/:id', (req, res) => {
    res.json(fullList(loadList(req), req));
  });

  r.patch('/:id', (req, res) => {
    const list = loadList(req);
    if (!canManageList(req, list)) throw httpError(403, 'Only grown-ups or the list’s creator can change this list');
    const body = req.body ?? {};
    const next = { ...list };
    if (body.name !== undefined) next.name = cleanStr(body.name, { field: 'Name', required: true, max: 80 });
    if (body.type !== undefined) next.type = cleanType(body.type, list.type);
    if (body.icon !== undefined) next.icon = cleanIcon(body.icon) ?? DEFAULTS[next.type].icon;
    if (body.color !== undefined) {
      if (!isColor(body.color)) throw httpError(400, 'Color must be a hex color like #30A46C');
      next.color = body.color;
    }
    ctx.tx(db, () => {
      db.prepare(`UPDATE lists SET name = ?, type = ?, icon = ?, color = ?, updated_at = ${ISO_NOW} WHERE id = ?`)
        .run(next.name, next.type, next.icon, next.color, list.id);
      // Turning a list into a shopping list: sort existing items into aisles.
      if (next.type === 'shopping' && list.type !== 'shopping') {
        const upd = db.prepare('UPDATE list_items SET category = ? WHERE id = ?');
        for (const it of db.prepare('SELECT id, text FROM list_items WHERE list_id = ? AND category IS NULL').all(list.id)) {
          upd.run(guessCategory(it.text), it.id);
        }
      }
    });
    const updated = getList.get(list.id, req.family.id);
    emit(req, 'updated', { list_id: list.id });
    if (updated.name !== list.name) {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'renamed', entityId: list.id,
        summary: `renamed ${list.name} to ${updated.name}`, link: `/lists/${list.id}`,
      });
    }
    res.json(fullList(updated, req));
  });

  r.delete('/:id', (req, res) => {
    const list = loadList(req);
    if (!canManageList(req, list)) throw httpError(403, 'Only grown-ups or the list’s creator can delete this list');
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
    emit(req, 'deleted', { list_id: list.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'deleted', entityId: list.id,
      summary: `deleted the list ${list.name}`, link: '/lists',
    });
    res.json({ ok: true });
  });

  r.post('/:id/duplicate', (req, res) => {
    const list = loadList(req);
    const body = req.body ?? {};
    const name = cleanStr(body.name, { field: 'Name', max: 80 }) ?? `${list.name} (copy)`.slice(0, 80);
    const copy = ctx.tx(db, () => {
      const { p } = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM lists WHERE family_id = ?').get(req.family.id);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO lists (family_id, name, type, icon, color, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.family.id, name, list.type, list.icon, list.color, p + 1, req.user.id);
      db.prepare(
        `INSERT INTO list_items (list_id, family_id, text, quantity, notes, category, assignee_id, position, created_by)
         SELECT ?, family_id, text, quantity, notes, category, assignee_id, position, ? FROM list_items
          WHERE list_id = ? AND deleted_at IS NULL ORDER BY position, id`,
      ).run(lastInsertRowid, req.user.id, list.id);
      return getList.get(lastInsertRowid, req.family.id);
    });
    emit(req, 'created', { list_id: copy.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'created', entityId: copy.id,
      summary: `created the list ${copy.icon ?? ''} ${copy.name}`.replace(/\s+/g, ' '), link: `/lists/${copy.id}`,
    });
    res.status(201).json(fullList(copy, req));
  });

  // ---- items ----------------------------------------------------------------------------------

  r.post('/:id/items', (req, res) => {
    const list = loadList(req);
    const f = itemFields(req, list, req.body ?? {});
    assertCanAssign(req, null, f.assignee_id);
    assertRoom(list.id, 1);
    const item = addItem(req, list, f, maxItemPos.get(list.id).p + 1);
    touchList.run(list.id);
    const out = serializeItem(item, req, list);
    emit(req, 'item.created', { list_id: list.id, item: out });
    notifyAssigned(req, list, item);
    queueActivity(ctx, { familyId: req.family.id, userId: req.user.id, list, kind: 'added', itemId: item.id, text: item.text });
    res.status(201).json(out);
  });

  // Cross-module (Meals -> Lists): add many items at once.
  r.post('/:id/items/bulk', (req, res) => {
    const list = loadList(req);
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'Items must be a non-empty array');
    if (items.length > MAX_BULK) throw httpError(400, `You can add at most ${MAX_BULK} items at once`);
    const fields = items.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw httpError(400, `Item ${i + 1} is invalid`);
      try {
        const f = itemFields(req, list, { ...raw, parse: raw.quantity === undefined });
        assertCanAssign(req, null, f.assignee_id);
        return f;
      } catch (err) {
        if (err.status) err.message = `Item ${i + 1}: ${err.message}`;
        throw err;
      }
    });
    assertRoom(list.id, fields.length);
    const { p } = maxItemPos.get(list.id);
    const created = ctx.tx(db, () => fields.map((f, i) => addItem(req, list, f, p + 1 + i)));
    touchList.run(list.id);
    const out = created.map((it) => serializeItem(it, req, list));
    emit(req, 'items.bulk', { list_id: list.id, count: out.length });
    for (const it of created) notifyAssigned(req, list, it);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'lists', verb: 'added', entityId: list.id,
      summary: out.length === 1 ? `added ${quote(out[0].text)} to ${list.name}` : `added ${out.length} items to ${list.name}`,
      link: `/lists/${list.id}`,
    });
    res.status(201).json({ items: out });
  });

  // Reordering is part of managing a list (grown-ups, or a child on their own list).
  r.put('/:id/items/order', (req, res) => {
    const list = loadList(req);
    if (!canManageList(req, list)) throw httpError(403, 'Only grown-ups or the list’s creator can reorder this list');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids must be a non-empty array of item ids');
    const clean = ids.map((v) => toId(v, 'item id'));
    if (new Set(clean).size !== clean.length) throw httpError(400, 'ids must not repeat');
    const current = listItemsStmt.all(list.id);
    const known = new Set(current.map((i) => i.id));
    if (clean.some((id) => !known.has(id))) throw httpError(400, 'Some items do not belong to this list');
    const given = new Set(clean);
    const order = [...clean, ...current.map((i) => i.id).filter((id) => !given.has(id))];
    const upd = db.prepare('UPDATE list_items SET position = ? WHERE id = ?');
    ctx.tx(db, () => order.forEach((id, i) => upd.run(i, id)));
    emit(req, 'items.reordered', { list_id: list.id, ids: order });
    res.json({ ids: order });
  });

  r.post('/:id/clear-completed', (req, res) => {
    const list = loadList(req);
    if (!canManageList(req, list)) throw httpError(403, 'Only grown-ups or the list’s creator can clear completed items');
    const { changes } = db.prepare('DELETE FROM list_items WHERE list_id = ? AND done = 1 AND deleted_at IS NULL').run(list.id);
    if (changes) {
      touchList.run(list.id);
      emit(req, 'items.cleared', { list_id: list.id, count: Number(changes) });
    }
    res.json({ deleted: Number(changes) });
  });

  r.post('/:id/uncheck-all', (req, res) => {
    const list = loadList(req);
    if (!canManageList(req, list)) throw httpError(403, 'Only grown-ups or the list’s creator can reset this list');
    const { changes } = db
      .prepare(`UPDATE list_items SET done = 0, done_by = NULL, done_at = NULL, updated_at = ${ISO_NOW}
                 WHERE list_id = ? AND done = 1 AND deleted_at IS NULL`)
      .run(list.id);
    if (changes) {
      touchList.run(list.id);
      emit(req, 'items.reset', { list_id: list.id, count: Number(changes) });
    }
    res.json({ reset: Number(changes) });
  });

  r.patch('/:id/items/:itemId', (req, res) => {
    const list = loadList(req);
    const item = loadItem(req, list);
    const body = req.body ?? {};
    const level = editLevel(req, list, item);
    const fullKeys = ['text', 'quantity', 'category', 'assignee_id', 'due_date', 'list_id'];
    if (fullKeys.some((k) => body[k] !== undefined) && level !== 'full') {
      throw httpError(403, level === 'notes'
        ? 'You can tick this off and add notes — ask a grown-up to change the rest'
        : 'You can only edit items you added or that are assigned to you');
    }
    if (body.notes !== undefined && level !== 'full') {
      throw httpError(403, level === 'notes' ? 'You can add a note, but not change the existing notes' : 'You can only edit items you added or that are assigned to you');
    }
    // Append-only note ("— Mia · Sep 30, 3:40 PM: done!"): what a child assignee can add; never
    // overwrites the grown-up's notes. Anyone who may edit notes can use it.
    let appendedNotes;
    if (body.add_note !== undefined) {
      if (level === 'none') throw httpError(403, 'You can only add notes to items you added or that are assigned to you');
      const note = cleanStr(body.add_note, { field: 'Note', required: true, max: 500 });
      const stamp = new Intl.DateTimeFormat('en-US', {
        timeZone: ctx.time.tz(req), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(new Date());
      appendedNotes = `${item.notes ? `${item.notes}\n` : ''}— ${firstName(req.user.name)} · ${stamp}: ${note}`;
      if (appendedNotes.length > 4000) throw httpError(400, 'This item has too many notes already');
    }
    if (body.done !== undefined && typeof body.done !== 'boolean') throw httpError(400, 'done must be true or false');

    const f = itemFields(req, list, body, { partial: true });
    assertCanAssign(req, item.assignee_id, f.assignee_id);

    // Moving to another list of the same family.
    let target = list;
    if (body.list_id !== undefined && Number(body.list_id) !== list.id) {
      target = getList.get(toId(body.list_id, 'list'), req.family.id);
      if (!target) throw httpError(404, 'Target list not found');
      assertRoom(target.id, 1);
    }
    const next = { ...item, ...f };
    if (appendedNotes !== undefined) next.notes = appendedNotes;
    if (target.id !== list.id) {
      next.list_id = target.id;
      next.position = maxItemPos.get(target.id).p + 1;
      if (target.type === 'shopping' && !next.category) next.category = guessCategory(next.text);
    }
    if (f.text !== undefined && list.type === 'shopping' && body.category === undefined && item.category === guessCategory(item.text)) {
      // The category was auto-guessed: re-guess for the new name.
      next.category = guessCategory(f.text);
    }
    if (f.due_date !== undefined && f.due_date !== item.due_date) next.reminded_on = null;
    if (f.assignee_id !== undefined && f.assignee_id !== item.assignee_id) next.reminded_on = null;
    const becameDone = body.done === true && !item.done;
    const becameUndone = body.done === false && !!item.done;
    if (becameDone) {
      next.done = 1;
      next.done_by = req.user.id;
      next.done_at = nowIso();
    } else if (becameUndone) {
      next.done = 0;
      next.done_by = null;
      next.done_at = null;
    }
    db.prepare(
      `UPDATE list_items SET list_id = ?, text = ?, quantity = ?, notes = ?, category = ?, assignee_id = ?, due_date = ?,
              done = ?, done_by = ?, done_at = ?, position = ?, reminded_on = ?, updated_at = ${ISO_NOW} WHERE id = ?`,
    ).run(
      next.list_id, next.text, next.quantity, next.notes, next.category, next.assignee_id, next.due_date,
      next.done, next.done_by, next.done_at, next.position, next.reminded_on, item.id,
    );
    touchList.run(list.id);
    if (target.id !== list.id) touchList.run(target.id);
    const saved = itemById.get(item.id);
    const out = serializeItem(saved, req, target);
    emit(req, 'item.updated', { list_id: list.id, item: out, ...(target.id !== list.id ? { moved_to: target.id } : {}) });

    if (saved.assignee_id && saved.assignee_id !== item.assignee_id) notifyAssigned(req, target, saved);
    if (becameDone) {
      queueActivity(ctx, { familyId: req.family.id, userId: req.user.id, list, kind: 'completed', itemId: item.id, text: item.text });
      // Tell whoever set up a chore that it got done (not for groceries).
      if (list.type !== 'shopping' && item.assignee_id && item.created_by && item.created_by !== req.user.id) {
        ctx.notify({
          familyId: req.family.id, userIds: [item.created_by], module: 'lists', excludeUserId: req.user.id,
          title: `${firstName(req.user.name)} finished a task`,
          body: `${item.text} · ${list.name}`,
          link: `/lists/${list.id}?item=${item.id}`,
        });
      }
    } else if (becameUndone) {
      unqueueItem({ familyId: req.family.id, listId: list.id, itemId: item.id, kind: 'completed' });
    }
    res.json(out);
  });

  // Soft delete: the row stays (hidden) for a day so Undo can restore it exactly.
  r.delete('/:id/items/:itemId', (req, res) => {
    const list = loadList(req);
    const item = loadItem(req, list);
    if (!canDeleteItem(req, list, item)) throw httpError(403, 'You can only delete items you added');
    db.prepare('UPDATE list_items SET deleted_at = ? WHERE id = ?').run(nowIso(), item.id);
    touchList.run(list.id);
    stashRemoved(item.id, unqueueItem({ familyId: req.family.id, listId: list.id, itemId: item.id }));
    emit(req, 'item.deleted', { list_id: list.id, item_id: item.id });
    res.json({ ok: true, restorable: true });
  });

  // Undo a delete: brings back the original row (creator, timestamps, done state, position)
  // silently — no notifications, no Wall entry.
  r.post('/:id/items/:itemId/restore', (req, res) => {
    const list = loadList(req);
    const item = getDeletedItem.get(toId(req.params.itemId, 'item id'), list.id, req.family.id);
    if (!item) throw httpError(404, 'This item can no longer be restored');
    if (!canDeleteItem(req, list, item)) throw httpError(403, 'You can only restore items you added');
    assertRoom(list.id, 1);
    db.prepare('UPDATE list_items SET deleted_at = NULL WHERE id = ?').run(item.id);
    touchList.run(list.id);
    const out = serializeItem(itemById.get(item.id), req, list);
    // Deleted within the batching window? Put its pending Wall entry back as if nothing happened.
    for (const e of takeStashed(item.id)) {
      queueActivity(ctx, { familyId: req.family.id, userId: e.userId, list, kind: e.kind, itemId: item.id, text: e.text });
    }
    emit(req, 'item.restored', { list_id: list.id, item: out });
    res.json(out);
  });

  // "Nudge": remind the assignee about a task right now.
  r.post('/:id/items/:itemId/remind', (req, res) => {
    const list = loadList(req);
    const item = loadItem(req, list);
    if (!item.assignee_id) throw httpError(400, 'This item isn’t assigned to anyone');
    if (item.done) throw httpError(400, 'This task is already done');
    if (item.assignee_id === req.user.id) throw httpError(400, 'You can’t nudge yourself');
    pruneNudges();
    if (nudges.has(item.id)) throw httpError(429, 'You just sent a reminder — give them a few minutes');
    nudges.set(item.id, Date.now());
    const due = dueLabel(item.due_date, ctx.time.todayForUser(item.assignee_id));
    ctx.notify({
      familyId: req.family.id, userIds: [item.assignee_id], module: 'lists', excludeUserId: req.user.id,
      title: `${firstName(req.user.name)} sent you a reminder`,
      body: `${item.text} · ${list.name}${due ? ` · ${due}` : ''}`,
      link: `/lists/${list.id}?item=${item.id}`,
    });
    res.json({ ok: true });
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// Hooks

export function search(ctx, familyId, q) {
  const pattern = String(q);
  const lists = ctx.db
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 0 AND i.deleted_at IS NULL) AS open_count
         FROM lists l WHERE l.family_id = ? AND search_match(l.name, ?) ORDER BY l.position LIMIT 4`,
    )
    .all(familyId, pattern)
    .map((l) => ({
      title: `${l.icon ?? DEFAULTS[l.type].icon} ${l.name}`,
      subtitle: `${TYPE_LABEL[l.type]} · ${l.open_count} open`,
      link: `/lists/${l.id}`,
    }));
  const items = ctx.db
    .prepare(
      `SELECT i.id, i.text, i.done, i.list_id, l.name AS list_name FROM list_items i JOIN lists l ON l.id = i.list_id
        WHERE i.family_id = ? AND i.deleted_at IS NULL AND (search_match(i.text, ?) OR search_match(i.notes, ?))
        ORDER BY i.done, i.updated_at DESC LIMIT 8`,
    )
    .all(familyId, pattern, pattern)
    .map((i) => ({ title: i.text, subtitle: `${i.done ? 'Done' : 'On'} · ${i.list_name}`, link: `/lists/${i.list_id}?item=${i.id}` }));
  return [...lists, ...items].slice(0, 8);
}

/** Wall card: my tasks due today / overdue (my local day) + open counts per list. */
export function dashboard(ctx, req) {
  const today = todayFor(ctx, req);
  const rows = ctx.db
    .prepare(
      `SELECT i.id, i.list_id, l.name AS list_name, l.icon AS list_icon, l.color AS list_color, l.type AS list_type,
              i.text, i.due_date, i.assignee_id
         FROM list_items i JOIN lists l ON l.id = i.list_id
        WHERE i.family_id = ? AND i.assignee_id = ? AND i.done = 0 AND i.deleted_at IS NULL AND l.type != 'shopping'
          AND i.due_date IS NOT NULL AND i.due_date <= ?
        ORDER BY i.due_date, l.position, i.position LIMIT 50`,
    )
    .all(req.family.id, req.user.id, today)
    .map((r) => ({ ...r, list_icon: r.list_icon ?? DEFAULTS[r.list_type].icon, list_color: r.list_color ?? DEFAULTS[r.list_type].color }));
  const lists = ctx.db
    .prepare(
      `SELECT l.id, l.name, l.type, l.icon, l.color,
              (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 0 AND i.deleted_at IS NULL) AS open_count
         FROM lists l WHERE l.family_id = ? ORDER BY l.position, l.id LIMIT 20`,
    )
    .all(req.family.id)
    .map((l) => ({ ...l, icon: l.icon ?? DEFAULTS[l.type].icon, color: l.color ?? DEFAULTS[l.type].color, open_count: Number(l.open_count) }));
  return {
    due: rows.filter((r) => r.due_date === today),
    overdue: rows.filter((r) => r.due_date < today),
    lists,
  };
}

export async function seed(ctx, args) {
  const today = ctx.time.todayForFamily(args.familyId);
  return seedLists(ctx, args, { day: (n) => addDays(today, n), guessCategory });
}
