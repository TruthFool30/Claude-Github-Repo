// Meal planner & recipes — module "meals", mounted at /api/meals.
//
//   Recipes   GET/POST /recipes, GET /recipes/tags, GET/PATCH/DELETE /recipes/:id,
//             POST/DELETE /recipes/:id/photo, PUT /recipes/:id/favorite
//   Plan      GET /plan?start=YYYY-MM-DD&days=7, POST /plan, PATCH/DELETE /plan/:id,
//             POST /plan/copy, DELETE /plan?start=&days= (clear), GET /plan/ingredients?start=&days=
//
// Realtime: meals.recipe.created|updated|deleted, meals.favorite.updated,
//           meals.plan.created|updated|deleted|restored|copied|cleared
// Removing meals is a soft delete (deleted_at / deleted_batch) so Undo can restore them exactly.
import { Router } from 'express';
import { ISO_NOW } from '../db.js';
import { cleanStr, httpError, isColor, isDate, toId } from '../util.js';
import { aggregateIngredients, parseIngredientLine } from './meals/shopping.js';
import { foodSvg } from './meals/art.js';
import { SEED_LAST_WEEK, SEED_RECIPES, SEED_THIS_WEEK } from './meals/seed-data.js';

export const name = 'meals';

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const SLOT_LABEL = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack' };
export const ICONS = [
  'utensils', 'soup', 'salad', 'pizza', 'sandwich', 'beef', 'fish', 'egg', 'croissant', 'cake', 'cookie', 'apple',
  'carrot', 'drumstick', 'coffee', 'ice-cream', 'wheat', 'cooking-pot', 'cherry', 'citrus',
];
// HEIC/HEIF is rejected: browsers can't display it (the client converts photos to JPEG before upload).
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_PER_SLOT = 6;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS meal_recipes (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     description TEXT,
     photo_url TEXT,
     icon TEXT NOT NULL DEFAULT 'utensils',
     color TEXT NOT NULL DEFAULT '#F76B15',
     servings INTEGER NOT NULL DEFAULT 4,
     prep_minutes INTEGER NOT NULL DEFAULT 0,
     cook_minutes INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]',
     steps TEXT NOT NULL DEFAULT '[]',
     source_url TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     updated_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS meal_recipes_family ON meal_recipes(family_id, title)`,
  `CREATE TABLE IF NOT EXISTS meal_recipe_ingredients (
     id INTEGER PRIMARY KEY,
     recipe_id INTEGER NOT NULL REFERENCES meal_recipes(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     quantity REAL,
     unit TEXT,
     name TEXT NOT NULL,
     note TEXT)`,
  `CREATE INDEX IF NOT EXISTS meal_recipe_ingredients_recipe ON meal_recipe_ingredients(recipe_id, position)`,
  `CREATE TABLE IF NOT EXISTS meal_recipe_favorites (
     recipe_id INTEGER NOT NULL REFERENCES meal_recipes(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW},
     PRIMARY KEY (recipe_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS meal_plan (
     id INTEGER PRIMARY KEY,
     family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
     date TEXT NOT NULL,
     slot TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
     position INTEGER NOT NULL DEFAULT 0,
     recipe_id INTEGER REFERENCES meal_recipes(id) ON DELETE SET NULL,
     title TEXT NOT NULL,
     note TEXT,
     servings INTEGER,
     cook_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT ${ISO_NOW})`,
  `CREATE INDEX IF NOT EXISTS meal_plan_family_date ON meal_plan(family_id, date)`,
  `ALTER TABLE meal_plan ADD COLUMN deleted_at TEXT`,
  `ALTER TABLE meal_plan ADD COLUMN deleted_batch TEXT`,
  `ALTER TABLE meal_plan ADD COLUMN created_batch TEXT`,
];

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, '0');
export const localDateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function mondayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(key, -dow);
}
function weekdayName(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function shortDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function rangeFrom(query, today) {
  const start = query.start === undefined || query.start === '' ? mondayOf(today) : query.start;
  if (!isDate(start)) throw httpError(400, 'start must be a date (YYYY-MM-DD)');
  const days = query.days === undefined || query.days === '' ? 7 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 42) throw httpError(400, 'days must be between 1 and 42');
  return { start, days, end: addDays(start, days - 1) };
}

// ---------------------------------------------------------------- validation

function intIn(value, { field, min, max, fallback = null }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${field} must be a whole number between ${min} and ${max}`);
  return n;
}

function cleanTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Tags must be a list');
  const out = [];
  for (const t of value) {
    if (typeof t !== 'string') throw httpError(400, 'Tags must be text');
    const tag = t.trim().replace(/^#/, '').replace(/\s+/g, ' ').toLowerCase();
    if (!tag) continue;
    if (tag.length > 30) throw httpError(400, 'Tags can be at most 30 characters');
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > 12) throw httpError(400, 'At most 12 tags per recipe');
  return out;
}

function cleanIngredients(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Ingredients must be a list');
  if (value.length > 100) throw httpError(400, 'At most 100 ingredients per recipe');
  const out = [];
  for (const raw of value) {
    let item = raw;
    if (typeof raw === 'string') {
      item = parseIngredientLine(raw);
      if (!item) continue;
    }
    if (!item || typeof item !== 'object') throw httpError(400, 'Invalid ingredient');
    const nameStr = cleanStr(item.name, { field: 'Ingredient name', max: 120 });
    if (!nameStr) {
      if ([item.quantity, item.unit, item.note].every((v) => v === undefined || v === null || v === '')) continue; // blank row
      throw httpError(400, 'Every ingredient needs a name');
    }
    let quantity = null;
    if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '') {
      quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100000) throw httpError(400, `Invalid quantity for ${nameStr}`);
      if (quantity === 0) quantity = null;
    }
    out.push({
      quantity,
      unit: cleanStr(item.unit, { field: 'Unit', max: 20 }),
      name: nameStr,
      note: cleanStr(item.note, { field: 'Ingredient note', max: 120 }),
    });
  }
  return out;
}

function cleanSteps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Steps must be a list');
  if (value.length > 60) throw httpError(400, 'At most 60 steps per recipe');
  const out = [];
  for (const s of value) {
    const step = cleanStr(s, { field: 'Step', max: 2000 });
    if (step) out.push(step);
  }
  return out;
}

function cleanUrl(value) {
  const s = cleanStr(value, { field: 'Source link', max: 500 });
  if (!s) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw httpError(400, 'Source link must start with http:// or https://');
  return s;
}

/** Validates a full or partial recipe payload. Returns only provided fields (all when !partial). */
function recipeInput(body, { partial }) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Invalid request');
  const has = (k) => !partial || body[k] !== undefined;
  const out = {};
  if (has('title')) out.title = cleanStr(body.title, { field: 'Title', required: true, max: 120 });
  if (has('description')) out.description = cleanStr(body.description, { field: 'Description', max: 2000 });
  if (has('servings')) out.servings = intIn(body.servings, { field: 'Servings', min: 1, max: 100, fallback: 4 });
  if (has('prep_minutes')) out.prep_minutes = intIn(body.prep_minutes, { field: 'Prep time', min: 0, max: 2880, fallback: 0 });
  if (has('cook_minutes')) out.cook_minutes = intIn(body.cook_minutes, { field: 'Cook time', min: 0, max: 2880, fallback: 0 });
  if (has('tags')) out.tags = cleanTags(body.tags);
  if (has('steps')) out.steps = cleanSteps(body.steps);
  if (has('ingredients')) out.ingredients = cleanIngredients(body.ingredients);
  if (has('source_url')) out.source_url = cleanUrl(body.source_url);
  if (has('icon')) {
    const icon = body.icon ?? 'utensils';
    if (!ICONS.includes(icon)) throw httpError(400, 'Unknown icon');
    out.icon = icon;
  }
  if (has('color')) {
    const color = body.color ?? '#F76B15';
    if (!isColor(color)) throw httpError(400, 'Color must be a hex color like #F76B15');
    out.color = color;
  }
  return out;
}

// ---------------------------------------------------------------- data access

function makeRepo(db) {
  const recipeRow = db.prepare('SELECT * FROM meal_recipes WHERE id = ? AND family_id = ?');
  const ingredientsOf = db.prepare('SELECT id, quantity, unit, name, note FROM meal_recipe_ingredients WHERE recipe_id = ? ORDER BY position, id');
  const favoritesOf = db.prepare(
    `SELECT f.user_id FROM meal_recipe_favorites f
       JOIN meal_recipes r ON r.id = f.recipe_id
       JOIN memberships m ON m.family_id = r.family_id AND m.user_id = f.user_id
      WHERE f.recipe_id = ? ORDER BY f.created_at`,
  );
  const familyFavorites = db.prepare(
    `SELECT f.recipe_id, f.user_id FROM meal_recipe_favorites f
       JOIN meal_recipes r ON r.id = f.recipe_id
       JOIN memberships m ON m.family_id = r.family_id AND m.user_id = f.user_id
      WHERE r.family_id = ? ORDER BY f.created_at`,
  );
  const ingredientCounts = db.prepare(
    `SELECT i.recipe_id, COUNT(*) AS n FROM meal_recipe_ingredients i JOIN meal_recipes r ON r.id = i.recipe_id
      WHERE r.family_id = ? GROUP BY i.recipe_id`,
  );
  const planStats = db.prepare(
    `SELECT recipe_id, COUNT(*) AS n, MAX(CASE WHEN date <= ? THEN date END) AS last_date, MIN(CASE WHEN date >= ? THEN date END) AS next_date
       FROM meal_plan WHERE family_id = ? AND recipe_id IS NOT NULL AND deleted_at IS NULL GROUP BY recipe_id`,
  );

  function shapeRecipe(row, { userId, favs, ingredientCount, stats }) {
    const favorited_by = favs ?? [];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      photo_url: row.photo_url,
      icon: row.icon,
      color: row.color,
      servings: row.servings,
      prep_minutes: row.prep_minutes,
      cook_minutes: row.cook_minutes,
      total_minutes: row.prep_minutes + row.cook_minutes,
      tags: JSON.parse(row.tags || '[]'),
      source_url: row.source_url,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      favorite: favorited_by.includes(userId),
      favorited_by,
      ingredient_count: ingredientCount ?? 0,
      step_count: JSON.parse(row.steps || '[]').length,
      plan_count: stats?.n ?? 0,
      last_planned: stats?.last_date ?? null,
      next_planned: stats?.next_date ?? null,
    };
  }

  return {
    getRow(id, familyId) {
      const row = recipeRow.get(id, familyId);
      if (!row) throw httpError(404, 'Recipe not found');
      return row;
    },
    list(familyId, userId, { q, tag, favorites, sort, today } = {}) {
      const where = ['r.family_id = ?'];
      const params = [familyId];
      if (q) {
        where.push(`(r.title LIKE '%' || ? || '%' OR r.description LIKE '%' || ? || '%' OR r.tags LIKE '%' || ? || '%'
                     OR EXISTS (SELECT 1 FROM meal_recipe_ingredients i WHERE i.recipe_id = r.id AND i.name LIKE '%' || ? || '%'))`);
        params.push(q, q, q, q);
      }
      if (tag) {
        where.push('EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = ?)');
        params.push(tag);
      }
      if (favorites) {
        where.push('EXISTS (SELECT 1 FROM meal_recipe_favorites f WHERE f.recipe_id = r.id AND f.user_id = ?)');
        params.push(userId);
      }
      const order = {
        title: 'r.title COLLATE NOCASE',
        quick: '(r.prep_minutes + r.cook_minutes), r.title COLLATE NOCASE',
        recent: 'r.created_at DESC, r.id DESC',
      }[sort] ?? 'r.created_at DESC, r.id DESC';
      const rows = db.prepare(`SELECT r.* FROM meal_recipes r WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...params);
      const favMap = new Map();
      for (const f of familyFavorites.all(familyId)) favMap.set(f.recipe_id, [...(favMap.get(f.recipe_id) ?? []), f.user_id]);
      const counts = new Map(ingredientCounts.all(familyId).map((c) => [c.recipe_id, c.n]));
      const stats = new Map(planStats.all(today, today, familyId).map((s) => [s.recipe_id, s]));
      let list = rows.map((row) => shapeRecipe(row, { userId, favs: favMap.get(row.id), ingredientCount: counts.get(row.id), stats: stats.get(row.id) }));
      if (sort === 'popular') list = list.sort((a, b) => b.favorited_by.length + b.plan_count - (a.favorited_by.length + a.plan_count) || a.title.localeCompare(b.title));
      return list;
    },
    detail(id, familyId, userId, today) {
      const row = this.getRow(id, familyId);
      const ingredients = ingredientsOf.all(row.id);
      const favs = favoritesOf.all(row.id).map((f) => f.user_id);
      const stats = planStats.all(today, today, familyId).find((s) => s.recipe_id === row.id);
      const upcoming = db
        .prepare('SELECT id, date, slot, cook_id FROM meal_plan WHERE family_id = ? AND recipe_id = ? AND date >= ? AND deleted_at IS NULL ORDER BY date, slot LIMIT 10')
        .all(familyId, row.id, today);
      return {
        ...shapeRecipe(row, { userId, favs, ingredientCount: ingredients.length, stats }),
        ingredients,
        steps: JSON.parse(row.steps || '[]'),
        upcoming,
      };
    },
    favorites(recipeId) {
      return favoritesOf.all(recipeId).map((f) => f.user_id);
    },
    replaceIngredients(recipeId, items) {
      db.prepare('DELETE FROM meal_recipe_ingredients WHERE recipe_id = ?').run(recipeId);
      const ins = db.prepare('INSERT INTO meal_recipe_ingredients (recipe_id, position, quantity, unit, name, note) VALUES (?, ?, ?, ?, ?, ?)');
      items.forEach((it, i) => ins.run(recipeId, i, it.quantity, it.unit, it.name, it.note));
    },
  };
}

const PLAN_SELECT = `
  SELECT p.id, p.date, p.slot, p.position, p.recipe_id, COALESCE(r.title, p.title) AS title, p.note, p.servings, p.cook_id,
         p.created_by, p.created_at,
         r.photo_url AS r_photo_url, r.icon AS r_icon, r.color AS r_color, r.servings AS r_servings,
         r.prep_minutes AS r_prep, r.cook_minutes AS r_cook
    FROM meal_plan p LEFT JOIN meal_recipes r ON r.id = p.recipe_id`;
const SLOT_ORDER = `CASE p.slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END`;

function shapeEntry(row) {
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    position: row.position,
    recipe_id: row.recipe_id,
    title: row.title,
    note: row.note,
    servings: row.servings,
    cook_id: row.cook_id,
    created_by: row.created_by,
    created_at: row.created_at,
    recipe: row.recipe_id
      ? { id: row.recipe_id, title: row.title, photo_url: row.r_photo_url, icon: row.r_icon, color: row.r_color, servings: row.r_servings, total_minutes: (row.r_prep ?? 0) + (row.r_cook ?? 0) }
      : null,
  };
}

function planRange(db, familyId, start, end) {
  return db
    .prepare(`${PLAN_SELECT} WHERE p.family_id = ? AND p.date BETWEEN ? AND ? AND p.deleted_at IS NULL ORDER BY p.date, ${SLOT_ORDER}, p.position, p.id`)
    .all(familyId, start, end)
    .map(shapeEntry);
}

function planEntry(db, familyId, id) {
  const row = db.prepare(`${PLAN_SELECT} WHERE p.id = ? AND p.family_id = ? AND p.deleted_at IS NULL`).get(id, familyId);
  if (!row) throw httpError(404, 'Meal not found');
  return shapeEntry(row);
}

function checkMember(db, familyId, userId) {
  if (userId === null || userId === undefined || userId === '') return null;
  const id = toId(userId, 'cook');
  if (!db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?').get(familyId, id)) {
    throw httpError(400, 'The cook must be a member of this family');
  }
  return id;
}

const canEdit = (req, row) => req.role !== 'child' || row.created_by === req.user.id;
const planLink = (date) => `/meals?week=${mondayOf(date)}`;

// ---------------------------------------------------------------- router

/** @param {import('./index.js').ModuleContext} ctx */
export function router(ctx) {
  const { db } = ctx;
  const repo = makeRepo(db);
  const r = Router();
  const todayOf = (req) => ctx.time?.today(req) ?? localDateKey();
  const liveRow = (id, familyId) => db.prepare('SELECT * FROM meal_plan WHERE id = ? AND family_id = ? AND deleted_at IS NULL').get(id, familyId);
  const slotCount = db.prepare('SELECT COUNT(*) AS n FROM meal_plan WHERE family_id = ? AND date = ? AND slot = ? AND deleted_at IS NULL');
  // Soft-deleted rows only need to live long enough for Undo.
  const sweep = (familyId) => db.prepare("DELETE FROM meal_plan WHERE family_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?").run(familyId, new Date(Date.now() - 864e5).toISOString());
  const newBatch = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  // Overview: counts + today's meals (handy for widgets; also proves the module is mounted).
  r.get('/', (req, res) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM meal_recipes WHERE family_id = ?').get(req.family.id);
    const start = mondayOf(todayOf(req));
    const { p } = db.prepare('SELECT COUNT(*) AS p FROM meal_plan WHERE family_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL').get(req.family.id, start, addDays(start, 6));
    res.json({ module: name, recipe_count: n, week_start: start, planned_this_week: p, ...dashboard(ctx, req) });
  });

  // ------------------------------------------------ recipes

  r.get('/recipes', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase().slice(0, 30) : '';
    const favorites = req.query.favorites === '1' || req.query.favorites === 'true';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    res.json(repo.list(req.family.id, req.user.id, { q, tag, favorites, sort, today: todayOf(req) }));
  });

  r.get('/recipes/tags', (req, res) => {
    const rows = db
      .prepare(
        `SELECT j.value AS tag, COUNT(*) AS count FROM meal_recipes r, json_each(r.tags) j
          WHERE r.family_id = ? GROUP BY j.value ORDER BY count DESC, j.value`,
      )
      .all(req.family.id);
    res.json(rows);
  });

  r.post('/recipes', (req, res) => {
    const input = recipeInput(req.body, { partial: false });
    const id = ctx.tx(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO meal_recipes (family_id, title, description, icon, color, servings, prep_minutes, cook_minutes, tags, steps, source_url, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(req.family.id, input.title, input.description, input.icon, input.color, input.servings, input.prep_minutes,
          input.cook_minutes, JSON.stringify(input.tags), JSON.stringify(input.steps), input.source_url, req.user.id);
      repo.replaceIngredients(Number(lastInsertRowid), input.ingredients);
      return Number(lastInsertRowid);
    });
    const recipe = repo.detail(id, req.family.id, req.user.id, todayOf(req));
    ctx.broadcast(req.family.id, 'meals.recipe.created', { id, by: req.user.id });
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'meals', verb: 'created', entityId: id,
      summary: `added the recipe ${recipe.title}`, link: `/meals/recipes/${id}`,
    });
    res.status(201).json(recipe);
  });

  r.get('/recipes/:id', (req, res) => {
    res.json(repo.detail(toId(req.params.id), req.family.id, req.user.id, todayOf(req)));
  });

  r.patch('/recipes/:id', (req, res) => {
    const row = repo.getRow(toId(req.params.id), req.family.id);
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can edit recipes added by someone else');
    const input = recipeInput(req.body, { partial: true });
    ctx.tx(db, () => {
      const cols = ['title', 'description', 'icon', 'color', 'servings', 'prep_minutes', 'cook_minutes', 'source_url'].filter((k) => k in input);
      const sets = cols.map((k) => `${k} = ?`);
      const vals = cols.map((k) => input[k]);
      if ('tags' in input) { sets.push('tags = ?'); vals.push(JSON.stringify(input.tags)); }
      if ('steps' in input) { sets.push('steps = ?'); vals.push(JSON.stringify(input.steps)); }
      sets.push(`updated_at = ${ISO_NOW}`);
      db.prepare(`UPDATE meal_recipes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
      if ('ingredients' in input) repo.replaceIngredients(row.id, input.ingredients);
    });
    const recipe = repo.detail(row.id, req.family.id, req.user.id, todayOf(req));
    ctx.broadcast(req.family.id, 'meals.recipe.updated', { id: row.id, by: req.user.id });
    res.json(recipe);
  });

  r.delete('/recipes/:id', (req, res) => {
    const row = repo.getRow(toId(req.params.id), req.family.id);
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can delete recipes added by someone else');
    db.prepare('DELETE FROM meal_recipes WHERE id = ?').run(row.id);
    if (row.photo_url) ctx.removeFile(row.photo_url);
    ctx.broadcast(req.family.id, 'meals.recipe.deleted', { id: row.id, by: req.user.id });
    res.json({ ok: true });
  });

  r.post('/recipes/:id/photo', ctx.upload.single('file'), (req, res) => {
    const row = repo.getRow(toId(req.params.id), req.family.id);
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can change photos of recipes added by someone else');
    if (!req.file) throw httpError(400, 'Please choose a photo');
    if (!PHOTO_TYPES.has(req.file.mimetype)) throw httpError(400, 'Please choose a JPEG, PNG, WebP or GIF image');
    db.prepare(`UPDATE meal_recipes SET photo_url = ?, updated_at = ${ISO_NOW} WHERE id = ?`).run(req.file.url, row.id);
    if (row.photo_url) ctx.removeFile(row.photo_url);
    ctx.broadcast(req.family.id, 'meals.recipe.updated', { id: row.id, by: req.user.id });
    if (!row.photo_url) {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'meals', verb: 'photo', entityId: row.id,
        summary: `added a photo to ${row.title}`, link: `/meals/recipes/${row.id}`,
      });
    }
    res.json(repo.detail(row.id, req.family.id, req.user.id, todayOf(req)));
  });

  r.delete('/recipes/:id/photo', (req, res) => {
    const row = repo.getRow(toId(req.params.id), req.family.id);
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can change photos of recipes added by someone else');
    if (row.photo_url) {
      db.prepare(`UPDATE meal_recipes SET photo_url = NULL, updated_at = ${ISO_NOW} WHERE id = ?`).run(row.id);
      ctx.removeFile(row.photo_url);
      ctx.broadcast(req.family.id, 'meals.recipe.updated', { id: row.id, by: req.user.id });
    }
    res.json(repo.detail(row.id, req.family.id, req.user.id, todayOf(req)));
  });

  r.put('/recipes/:id/favorite', (req, res) => {
    const row = repo.getRow(toId(req.params.id), req.family.id);
    const fav = req.body?.favorite;
    if (typeof fav !== 'boolean') throw httpError(400, 'favorite must be true or false');
    if (fav) db.prepare('INSERT OR IGNORE INTO meal_recipe_favorites (recipe_id, user_id) VALUES (?, ?)').run(row.id, req.user.id);
    else db.prepare('DELETE FROM meal_recipe_favorites WHERE recipe_id = ? AND user_id = ?').run(row.id, req.user.id);
    const favorited_by = repo.favorites(row.id);
    ctx.broadcast(req.family.id, 'meals.favorite.updated', { id: row.id, user_id: req.user.id, favorite: fav });
    res.json({ id: row.id, favorite: fav, favorited_by });
  });

  // ------------------------------------------------ plan

  r.get('/plan', (req, res) => {
    const { start, days, end } = rangeFrom(req.query, todayOf(req));
    res.json({ start, end, days, entries: planRange(db, req.family.id, start, end) });
  });

  r.get('/plan/ingredients', (req, res) => {
    const { start, days, end } = rangeFrom(req.query, todayOf(req));
    const entries = planRange(db, req.family.id, start, end);
    const withRecipe = entries.filter((e) => e.recipe);
    const rows = [];
    const getIngredients = db.prepare('SELECT quantity, unit, name FROM meal_recipe_ingredients WHERE recipe_id = ? ORDER BY position, id');
    for (const e of withRecipe) {
      const factor = e.servings && e.recipe.servings ? e.servings / e.recipe.servings : 1;
      for (const ing of getIngredients.all(e.recipe_id)) rows.push({ ...ing, factor, recipe_title: e.title });
    }
    res.json({
      start, end, days,
      meal_count: withRecipe.length,
      free_text: entries.filter((e) => !e.recipe).map((e) => ({ id: e.id, date: e.date, slot: e.slot, title: e.title })),
      items: aggregateIngredients(rows),
    });
  });

  function planInput(body, { partial }) {
    if (!body || typeof body !== 'object') throw httpError(400, 'Invalid request');
    const has = (k) => !partial || body[k] !== undefined;
    const out = {};
    if (has('date')) {
      if (!isDate(body.date)) throw httpError(400, 'Choose a valid date');
      out.date = body.date;
    }
    if (has('slot')) {
      if (!SLOTS.includes(body.slot)) throw httpError(400, 'Meal must be breakfast, lunch, dinner or snack');
      out.slot = body.slot;
    }
    if (has('recipe_id')) {
      if (body.recipe_id === null || body.recipe_id === undefined || body.recipe_id === '') out.recipe_id = null;
      else out.recipe = repo.getRow(toId(body.recipe_id, 'recipe'), body.__familyId);
    }
    if (has('title')) out.title = cleanStr(body.title, { field: 'Meal name', max: 120 });
    if (has('note')) out.note = cleanStr(body.note, { field: 'Note', max: 300 });
    if (has('servings')) out.servings = intIn(body.servings, { field: 'Servings', min: 1, max: 100 });
    if (has('cook_id')) out.cook_id = checkMember(db, body.__familyId, body.cook_id);
    return out;
  }

  function notifyCook(req, entry, previousCook = null) {
    if (!entry.cook_id || entry.cook_id === previousCook || entry.cook_id === req.user.id) return;
    ctx.notify({
      familyId: req.family.id, userIds: [entry.cook_id], module: 'meals',
      title: `You're cooking ${entry.title}`,
      body: `${shortDate(entry.date)} · ${SLOT_LABEL[entry.slot]} — assigned by ${req.user.name.split(' ')[0]}`,
      link: planLink(entry.date), excludeUserId: req.user.id,
    });
  }

  r.post('/plan', (req, res) => {
    const input = planInput({ ...req.body, __familyId: req.family.id }, { partial: false });
    const title = input.recipe ? input.recipe.title : input.title;
    if (!title) throw httpError(400, 'Pick a recipe or type what you are having');
    const { n } = slotCount.get(req.family.id, input.date, input.slot);
    if (n >= MAX_PER_SLOT) throw httpError(400, `That ${input.slot} already has ${MAX_PER_SLOT} dishes`);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO meal_plan (family_id, date, slot, position, recipe_id, title, note, servings, cook_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.family.id, input.date, input.slot, n, input.recipe?.id ?? null, title, input.note, input.servings, input.cook_id, req.user.id);
    const entry = planEntry(db, req.family.id, Number(lastInsertRowid));
    ctx.broadcast(req.family.id, 'meals.plan.created', entry);
    ctx.logActivity({
      familyId: req.family.id, userId: req.user.id, module: 'meals', verb: 'planned', entityId: entry.id,
      summary: `planned ${entry.title} for ${weekdayName(entry.date)} ${SLOT_LABEL[entry.slot]}`, link: planLink(entry.date),
    });
    notifyCook(req, entry);
    res.status(201).json(entry);
  });

  r.patch('/plan/:id', (req, res) => {
    const id = toId(req.params.id);
    const row = liveRow(id, req.family.id);
    if (!row) throw httpError(404, 'Meal not found');
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can change meals planned by someone else');
    const input = planInput({ ...req.body, __familyId: req.family.id }, { partial: true });
    const next = {
      date: input.date ?? row.date,
      slot: input.slot ?? row.slot,
      recipe_id: 'recipe' in input ? input.recipe.id : 'recipe_id' in input ? null : row.recipe_id,
      title: row.title,
      note: 'note' in input ? input.note : row.note,
      servings: 'servings' in input ? input.servings : row.servings,
      cook_id: 'cook_id' in input ? input.cook_id : row.cook_id,
      position: row.position,
    };
    if ('recipe' in input) next.title = input.recipe.title;
    else if (input.title) next.title = input.title;
    else if ('recipe_id' in input && !input.title) {
      // Switching to free text keeps the recipe's name unless a new title was given.
      const cur = row.recipe_id ? db.prepare('SELECT title FROM meal_recipes WHERE id = ?').get(row.recipe_id) : null;
      next.title = cur?.title ?? row.title;
    } else if ('title' in input && !input.title && !next.recipe_id) throw httpError(400, 'Meal name is required');
    if (next.date !== row.date || next.slot !== row.slot) {
      const { n } = slotCount.get(req.family.id, next.date, next.slot);
      if (n >= MAX_PER_SLOT) throw httpError(400, `That ${next.slot} already has ${MAX_PER_SLOT} dishes`);
      next.position = n;
    }
    db.prepare('UPDATE meal_plan SET date = ?, slot = ?, position = ?, recipe_id = ?, title = ?, note = ?, servings = ?, cook_id = ? WHERE id = ?')
      .run(next.date, next.slot, next.position, next.recipe_id, next.title, next.note, next.servings, next.cook_id, id);
    const entry = planEntry(db, req.family.id, id);
    ctx.broadcast(req.family.id, 'meals.plan.updated', entry);
    notifyCook(req, entry, row.cook_id);
    res.json(entry);
  });

  r.delete('/plan/:id', (req, res) => {
    const id = toId(req.params.id);
    const row = liveRow(id, req.family.id);
    if (!row) throw httpError(404, 'Meal not found');
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can remove meals planned by someone else');
    sweep(req.family.id);
    db.prepare('UPDATE meal_plan SET deleted_at = ?, deleted_batch = NULL WHERE id = ?').run(new Date().toISOString(), id);
    ctx.broadcast(req.family.id, 'meals.plan.deleted', { id, date: row.date, slot: row.slot });
    res.json({ ok: true, id });
  });

  // Undo a single removal: brings back the very same row (same id, cook, note) without new
  // activity or notifications.
  r.post('/plan/:id/restore', (req, res) => {
    const id = toId(req.params.id);
    const row = db.prepare('SELECT * FROM meal_plan WHERE id = ? AND family_id = ? AND deleted_at IS NOT NULL').get(id, req.family.id);
    if (!row) throw httpError(404, 'Nothing to restore');
    if (!canEdit(req, row)) throw httpError(403, 'Only grown-ups can restore meals planned by someone else');
    if (slotCount.get(req.family.id, row.date, row.slot).n >= MAX_PER_SLOT) {
      throw httpError(400, `That ${row.slot} already has ${MAX_PER_SLOT} dishes — remove one first`);
    }
    db.prepare('UPDATE meal_plan SET deleted_at = NULL, deleted_batch = NULL WHERE id = ?').run(id);
    const entry = planEntry(db, req.family.id, id);
    ctx.broadcast(req.family.id, 'meals.plan.restored', entry);
    res.json(entry);
  });

  // Undo a whole-week action (copy, replace, clear): removes what it added, restores what it removed.
  r.post('/plan/restore', (req, res) => {
    if (req.role === 'child') throw httpError(403, 'Ask a grown-up to undo that');
    const batch = typeof req.body?.batch === 'string' ? req.body.batch.slice(0, 40) : '';
    if (!batch) throw httpError(400, 'batch is required');
    let removed = 0;
    let restored = 0;
    let skipped = 0;
    ctx.tx(db, () => {
      removed = Number(db.prepare('DELETE FROM meal_plan WHERE family_id = ? AND created_batch = ?').run(req.family.id, batch).changes);
      const rows = db
        .prepare(`SELECT p.id, p.date, p.slot FROM meal_plan p WHERE p.family_id = ? AND p.deleted_batch = ? ORDER BY p.date, ${SLOT_ORDER}, p.position, p.id`)
        .all(req.family.id, batch);
      const undelete = db.prepare('UPDATE meal_plan SET deleted_at = NULL, deleted_batch = NULL WHERE id = ?');
      const drop = db.prepare('DELETE FROM meal_plan WHERE id = ?');
      for (const row of rows) {
        // Never overfill a slot: meals added since then keep their place; extras are dropped and reported.
        if (slotCount.get(req.family.id, row.date, row.slot).n >= MAX_PER_SLOT) { drop.run(row.id); skipped++; continue; }
        undelete.run(row.id);
        restored++;
      }
    });
    if (!removed && !restored && !skipped) throw httpError(404, 'Nothing to undo');
    ctx.broadcast(req.family.id, 'meals.plan.restored', { batch, removed, restored, skipped });
    res.json({ removed, restored, skipped });
  });

  r.post('/plan/copy', (req, res) => {
    if (req.role === 'child') throw httpError(403, 'Ask a grown-up to copy a whole week');
    const from = req.body?.from;
    const to = req.body?.to;
    if (!isDate(from) || !isDate(to)) throw httpError(400, 'from and to must be dates (YYYY-MM-DD)');
    if (from === to) throw httpError(400, 'Pick a different week to copy from');
    const days = intIn(req.body?.days, { field: 'days', min: 1, max: 28, fallback: 7 });
    if (days % 7 === 0 && (mondayOf(from) !== from || mondayOf(to) !== to)) throw httpError(400, 'Weeks start on a Monday');
    if (Math.abs(Date.parse(to) - Date.parse(from)) / 864e5 < days) throw httpError(400, 'The weeks overlap — pick a week that does not');
    const replace = req.body?.replace === true;
    const src = db
      .prepare(`SELECT p.* FROM meal_plan p WHERE p.family_id = ? AND p.date BETWEEN ? AND ? AND p.deleted_at IS NULL ORDER BY p.date, ${SLOT_ORDER}, p.position, p.id`)
      .all(req.family.id, from, addDays(from, days - 1));
    if (!src.length) throw httpError(400, 'There are no meals to copy in that week');
    const toEnd = addDays(to, days - 1);
    const dayOffset = (d) => Math.round((Date.parse(d) - Date.parse(from)) / 864e5);
    let copied = 0;
    let skipped = 0;
    let replaced = 0;
    const batch = newBatch();
    const isMember = db.prepare('SELECT 1 FROM memberships WHERE family_id = ? AND user_id = ?');
    sweep(req.family.id);
    ctx.tx(db, () => {
      if (replace) {
        replaced = Number(db.prepare('UPDATE meal_plan SET deleted_at = ?, deleted_batch = ? WHERE family_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL')
          .run(new Date().toISOString(), batch, req.family.id, to, toEnd).changes);
      }
      const count = slotCount;
      const ins = db.prepare('INSERT INTO meal_plan (family_id, date, slot, position, recipe_id, title, note, servings, cook_id, created_by, created_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const dupe = db.prepare('SELECT 1 FROM meal_plan WHERE family_id = ? AND date = ? AND slot = ? AND title = ? AND COALESCE(recipe_id, 0) = COALESCE(?, 0) AND deleted_at IS NULL');
      for (const e of src) {
        const date = addDays(to, dayOffset(e.date));
        if (!replace && dupe.get(req.family.id, date, e.slot, e.title, e.recipe_id)) { skipped++; continue; }
        const { n } = count.get(req.family.id, date, e.slot);
        if (n >= MAX_PER_SLOT) { skipped++; continue; }
        const cook = e.cook_id && isMember.get(req.family.id, e.cook_id) ? e.cook_id : null; // people who left don't cook
        ins.run(req.family.id, date, e.slot, n, e.recipe_id, e.title, e.note, e.servings, cook, req.user.id, batch);
        copied++;
      }
    });
    ctx.broadcast(req.family.id, 'meals.plan.copied', { from, to, days, copied });
    if (copied) {
      ctx.logActivity({
        familyId: req.family.id, userId: req.user.id, module: 'meals', verb: 'copied',
        summary: `copied ${copied} meal${copied === 1 ? '' : 's'} into the week of ${shortDate(to).replace(/^\w+, /, '')}`, link: planLink(to),
      });
    }
    res.json({ copied, skipped, replaced, batch, entries: planRange(db, req.family.id, to, toEnd) });
  });

  r.delete('/plan', (req, res) => {
    if (req.role === 'child') throw httpError(403, 'Ask a grown-up to clear a whole week');
    const { start, end } = rangeFrom({ start: req.query.start ?? req.body?.start, days: req.query.days ?? req.body?.days }, todayOf(req));
    if (req.query.start === undefined && req.body?.start === undefined) throw httpError(400, 'start is required');
    sweep(req.family.id);
    const batch = newBatch();
    const { changes } = db.prepare('UPDATE meal_plan SET deleted_at = ?, deleted_batch = ? WHERE family_id = ? AND date BETWEEN ? AND ? AND deleted_at IS NULL')
      .run(new Date().toISOString(), batch, req.family.id, start, end);
    ctx.broadcast(req.family.id, 'meals.plan.cleared', { start, end, deleted: Number(changes) });
    res.json({ deleted: Number(changes), batch });
  });

  return r;
}

// ---------------------------------------------------------------- hooks

export function dashboard(ctx, req) {
  const date = isDate(req.query?.date) ? req.query.date : ctx.time?.today(req) ?? localDateKey();
  const today = planRange(ctx.db, req.family.id, date, date).map((e) => ({
    id: e.id,
    slot: e.slot,
    title: e.title,
    ...(e.recipe_id ? { recipe_id: e.recipe_id } : {}),
    photo_url: e.recipe?.photo_url ?? null,
    icon: e.recipe?.icon ?? null,
    color: e.recipe?.color ?? null,
    cook_id: e.cook_id,
  }));
  return { date, today };
}

export function search(ctx, familyId, q) {
  return ctx.db
    .prepare(
      `SELECT r.id, r.title, r.prep_minutes + r.cook_minutes AS mins, r.tags FROM meal_recipes r
        WHERE r.family_id = ? AND (search_match(r.title, ?) OR search_match(r.tags, ?)
              OR EXISTS (SELECT 1 FROM meal_recipe_ingredients i WHERE i.recipe_id = r.id AND search_match(i.name, ?)))
        ORDER BY (r.title LIKE ? || '%') DESC, (search_match(r.title, ?)) DESC, r.title COLLATE NOCASE LIMIT 8`,
    )
    .all(familyId, q, q, q, q, q)
    .map((r) => {
      const tags = JSON.parse(r.tags || '[]').slice(0, 2);
      return {
        title: r.title,
        subtitle: ['Recipe', r.mins ? `${r.mins} min` : null, tags.join(', ') || null].filter(Boolean).join(' · '),
        link: `/meals/recipes/${r.id}`,
      };
    });
}

export async function seed(ctx, { familyId, users }) {
  const { db } = ctx;
  const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString();
  const ids = {};
  const insRecipe = db.prepare(
    `INSERT INTO meal_recipes (family_id, title, description, photo_url, icon, color, servings, prep_minutes, cook_minutes, tags, steps, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insIng = db.prepare('INSERT INTO meal_recipe_ingredients (recipe_id, position, quantity, unit, name, note) VALUES (?, ?, ?, ?, ?, ?)');
  const insFav = db.prepare('INSERT OR IGNORE INTO meal_recipe_favorites (recipe_id, user_id, created_at) VALUES (?, ?, ?)');
  const n = SEED_RECIPES.length;
  SEED_RECIPES.forEach((rec, i) => {
    const photo = rec.art ? ctx.storeFile(familyId, foodSvg({ ...rec.art, seed: rec.key }), '.svg') : null;
    const created = ago(60 - Math.round((i * 50) / n), i);
    const { lastInsertRowid } = insRecipe.run(
      familyId, rec.title, rec.description, photo, rec.icon, rec.color, rec.servings, rec.prep, rec.cook,
      JSON.stringify(rec.tags), JSON.stringify(rec.steps), users[rec.by].id, created, created,
    );
    const id = Number(lastInsertRowid);
    ids[rec.key] = id;
    rec.ingredients.forEach(([q, u, nm, note], pos) => insIng.run(id, pos, q, u, nm, note ?? null));
    rec.favs.forEach((k, j) => insFav.run(id, users[k].id, ago(50 - i - j)));
    ctx.logActivity({
      familyId, userId: users[rec.by].id, module: 'meals', verb: 'created', entityId: id,
      summary: `added the recipe ${rec.title}`, link: `/meals/recipes/${id}`, createdAt: created,
    });
  });

  const monday = mondayOf(ctx.time?.todayForFamily?.(familyId) ?? localDateKey());
  const insPlan = db.prepare(
    'INSERT INTO meal_plan (family_id, date, slot, position, recipe_id, title, note, cook_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const addWeek = (start, list, createdAt) => {
    const pos = new Map();
    for (const [day, slot, what, cook, note] of list) {
      const date = addDays(start, day);
      const k = `${date}|${slot}`;
      const p = pos.get(k) ?? 0;
      pos.set(k, p + 1);
      const recipeKey = typeof what === 'string' ? what : null;
      const title = recipeKey ? SEED_RECIPES.find((x) => x.key === recipeKey).title : what.title;
      insPlan.run(familyId, date, slot, p, recipeKey ? ids[recipeKey] : null, title, note ?? null, cook ? users[cook].id : null,
        (day + list.length) % 3 === 0 ? users.sam.id : users.alex.id, createdAt);
    }
  };
  addWeek(addDays(monday, -7), SEED_LAST_WEEK, ago(12));
  addWeek(monday, SEED_THIS_WEEK, ago(3));

  ctx.logActivity({
    familyId, userId: users.sam.id, module: 'meals', verb: 'copied',
    summary: `copied ${SEED_LAST_WEEK.length} meals into the week of ${shortDate(monday).replace(/^\w+, /, '')}`, link: planLink(monday), createdAt: ago(3, 2),
  });
  ctx.logActivity({
    familyId, userId: users.alex.id, module: 'meals', verb: 'planned',
    summary: `planned Coconut Chicken Curry for ${weekdayName(addDays(monday, 2))} dinner`, link: planLink(monday), createdAt: ago(2, 5),
  });
  ctx.logActivity({
    familyId, userId: users.leo.id, module: 'meals', verb: 'planned',
    summary: `planned Homemade Margherita Pizza for ${weekdayName(addDays(monday, 4))} dinner`, link: planLink(monday), createdAt: ago(1, 3),
  });
  ctx.notify({
    familyId, userIds: [users.alex.id], module: 'meals',
    title: 'You\'re cooking Coconut Chicken Curry',
    body: `${shortDate(addDays(monday, 2))} · dinner — assigned by Sam`, link: planLink(monday),
  });
  ctx.notify({
    familyId, userIds: [users.mia.id], module: 'meals',
    title: 'You\'re cooking Fluffy Blueberry Pancakes',
    body: `${shortDate(addDays(monday, 5))} · breakfast — assigned by Alex`, link: planLink(monday),
  });
}
