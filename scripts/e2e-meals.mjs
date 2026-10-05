// Meals module browser checks (Playwright). Runs against any running, seeded instance — it creates its
// own recipes in a far-future week and cleans them up, so it doesn't depend on the demo data:
//   PORT=4206 DB_PATH=/tmp/meals-build/hearth.db UPLOAD_DIR=/tmp/meals-build/up npm run seed
//   PORT=4206 DB_PATH=/tmp/meals-build/hearth.db UPLOAD_DIR=/tmp/meals-build/up HEARTH_RATE_LIMITS=off npm start
//   BASE=http://localhost:4206 SHOTS=/tmp/meals-shots node scripts/e2e-meals.mjs
// Needs the demo users (alex/sam/mia @hearth.test, password hearth123). Exits non-zero on the first failure.
// Screenshots of every main screen/dialog (desktop + mobile, light + dark) go to $SHOTS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Run Node and the browser in the demo family's time zone (seed.js DEMO_TZ), so "today" matches the server.
process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';

const BASE = process.env.BASE || 'http://localhost:4206';
const SHOTS = process.env.SHOTS || '/tmp/meals-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const pageErrors = [];
let passed = 0;
const TAG = Math.random().toString(36).slice(2, 7);
const expectedErrors = []; // regexes for console errors a step causes on purpose

async function newPage({ mobile = false, theme = 'light', email = 'alex@hearth.test' } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
  });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (expectedErrors.some((re) => re.test(text))) return;
    pageErrors.push(`${email} console: ${text}`);
  });
  const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert.ok(r.ok(), `login ${email}`);
  return { ctx, page };
}
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const noOverflow = async (page, where) => {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw, `${where}: horizontal overflow ${sw} > ${iw}`);
};
async function api(page, method, url, data) {
  const res = await page.request.fetch(`${BASE}${url}`, { method, data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
const key = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const addDays = (k, n) => {
  const [y, m, d] = k.split('-').map(Number);
  return key(new Date(y, m - 1, d + n));
};
const thisMonday = (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return key(d);
})();
// A far-future pair of weeks nobody plans for; cleared before use.
const SRC = addDays(thisMonday, 7 * (60 + Math.floor(Math.random() * 40)));
const DST = addDays(SRC, 7);
const weekday = (k) => new Date(`${k}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });

// ---------------------------------------------------------------------------------------------
const alex = await newPage();
const sam = await newPage({ email: 'sam@hearth.test' });
const { page } = alex;
const samId = (await api(sam.page, 'GET', '/api/auth/me')).body.user.id;

// Fixtures
const pastaTitle = `E2E Pasta ${TAG}`;
const saladTitle = `E2E Salad ${TAG}`;
const created = [];
const createdLists = [];
const mk = async (body) => {
  const r = await api(page, 'POST', '/api/meals/recipes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  created.push(r.body.id);
  return r.body;
};
const pasta = await mk({
  title: pastaTitle, servings: 4, prep_minutes: 10, cook_minutes: 20, tags: ['dinner', `e2e-${TAG}`], icon: 'utensils', color: '#E5484D',
  ingredients: ['400 g penne pasta', '8 small tortillas', '3 egg', '2 tbsp butter', '325 ml warm water'], steps: ['Boil for 10 minutes.', 'Serve.'],
});
const salad = await mk({
  title: saladTitle, servings: 2, prep_minutes: 10, cook_minutes: 0, tags: ['lunch', `e2e-${TAG}`], icon: 'salad', color: '#30A46C',
  ingredients: ['2 cups spinach', '100 g feta', '1 cup blueberries', '50 g butter'], steps: ['Toss everything.'],
});
for (const w of [SRC, DST]) await api(page, 'DELETE', `/api/meals/plan?start=${w}&days=7`);
await api(page, 'POST', '/api/meals/plan', { date: SRC, slot: 'dinner', recipe_id: pasta.id, cook_id: samId });
await api(page, 'POST', '/api/meals/plan', { date: addDays(SRC, 2), slot: 'lunch', recipe_id: salad.id });

await check('planner shows the week grid with planned meals', async () => {
  await page.goto(`${BASE}/meals?week=${SRC}`);
  await page.getByRole('grid', { name: 'Weekly meal plan' }).waitFor();
  assert.equal(await page.getByRole('rowheader').count(), 7);
  await page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor();
  assert.match(await page.locator('main').innerText(), /2 meals planned · dinner 1\/7 nights/);
  await noOverflow(page, 'planner desktop');
});

await check('column headers stick below the top bar while scrolling', async () => {
  const header = page.getByRole('columnheader', { name: 'Dinner' });
  const natural = await header.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  // Make sure the page can scroll past the header even for a sparse week.
  await page.evaluate(() => { document.body.style.paddingBottom = '1200px'; });
  await page.evaluate((y) => window.scrollTo(0, y), natural - 64 + 200); // header would be 200px above the bar without sticky
  await page.waitForTimeout(200);
  const scrolled = await page.evaluate(() => window.scrollY);
  assert.ok(scrolled > natural, 'scrolled past the header');
  const top = await header.evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(Math.abs(top - 64) <= 2, `header sticks at the 64px top bar (top ${top})`);
  await page.evaluate(() => { document.body.style.paddingBottom = ''; });
  await shot(page, 'desktop-light-planner-scrolled');
  await page.evaluate(() => window.scrollTo(0, 0));
});

await check('adding a meal via the dialog appears live in a second browser and notifies the cook', async () => {
  await sam.page.goto(`${BASE}/meals?week=${SRC}`);
  await sam.page.getByRole('grid').waitFor();
  await page.getByRole('button', { name: /^Add lunch on Monday/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search recipes').fill(TAG);
  await dialog.getByRole('option', { name: new RegExp(saladTitle) }).click();
  await dialog.getByRole('button', { name: 'Sam' }).click();
  await dialog.getByLabel('Note').fill(`Pack extra feta ${TAG}`);
  await dialog.getByRole('button', { name: 'Add to plan' }).click();
  await dialog.waitFor({ state: 'detached' });
  await sam.page.getByRole('gridcell').filter({ hasText: `Pack extra feta ${TAG}` }).waitFor({ timeout: 5000 });
  const notes = await api(sam.page, 'GET', '/api/notifications');
  assert.ok(notes.body.items.some((n) => n.title === `You're cooking ${saladTitle}`), JSON.stringify(notes.body.items.slice(0, 3)));
});

await check('edit to free text, remove, and undo restores the very same meal', async () => {
  await page.getByRole('gridcell').filter({ hasText: `Pack extra feta ${TAG}` }).getByRole('button').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Something else' }).click();
  await dialog.getByLabel("What's on the menu?").fill(`Picnic ${TAG}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  await sam.page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).waitFor({ timeout: 5000 });
  const before = (await api(page, 'GET', `/api/meals/plan?start=${SRC}`)).body.entries.find((e) => e.title === `Picnic ${TAG}`);
  const notesBefore = (await api(sam.page, 'GET', '/api/notifications')).body.items.length;
  await page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).waitFor({ state: 'detached' });
  await sam.page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).waitFor({ state: 'detached', timeout: 5000 });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).waitFor();
  await sam.page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).waitFor({ timeout: 5000 });
  const after = (await api(page, 'GET', `/api/meals/plan?start=${SRC}`)).body.entries.find((e) => e.title === `Picnic ${TAG}`);
  assert.equal(after.id, before.id, 'same row restored');
  assert.equal(after.cook_id, samId);
  assert.equal((await api(sam.page, 'GET', '/api/notifications')).body.items.length, notesBefore, 'no duplicate cook notification');
});

await check('drag and drop moves a meal to another slot', async () => {
  await page.getByRole('button', { name: new RegExp(`Picnic ${TAG}`) }).dragTo(page.getByRole('button', { name: /^Add breakfast on Tuesday/ }));
  for (let i = 0; i < 30; i++) {
    const e = (await api(page, 'GET', `/api/meals/plan?start=${SRC}`)).body.entries.find((x) => x.title === `Picnic ${TAG}`);
    if (e && e.date === addDays(SRC, 1) && e.slot === 'breakfast') return;
    await page.waitForTimeout(150);
  }
  assert.fail('meal did not move to Tuesday breakfast');
});

await check('empty week invites you to copy; copy → undo → copy → clear → undo', async () => {
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByText('A fresh week to plan').waitFor();
  assert.match(page.url(), new RegExp(`week=${DST}`));
  await shot(page, 'desktop-light-empty-week');
  await sam.page.goto(`${BASE}/meals?week=${DST}`);
  await sam.page.getByText('A fresh week to plan').waitFor();
  // Offered once (in the empty-week card, not again in the toolbar).
  assert.equal(await page.getByRole('button', { name: 'Copy last week' }).count(), 1, 'empty week card offers Copy last week once');
  await page.getByRole('button', { name: 'Copy last week' }).click();
  await page.getByText(/Copied 3 meals from last week/).waitFor();
  await sam.page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('A fresh week to plan').waitFor();
  await sam.page.getByText('A fresh week to plan').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Copy last week' }).first().click();
  await page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor();
  await page.getByRole('button', { name: 'Week actions' }).click();
  await page.getByRole('menuitem', { name: 'Clear this week' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear week' }).click();
  await page.getByText('A fresh week to plan').waitFor();
  await page.getByText(/Cleared 3 meals/).locator('..').locator('..').getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor();
  assert.equal((await api(page, 'GET', `/api/meals/plan?start=${DST}`)).body.entries.length, 3);
  await api(page, 'DELETE', `/api/meals/plan?start=${DST}&days=7`);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor();
});

await check('shopping list degrades gracefully when Lists is unavailable', async () => {
  await page.route('**/api/lists?type=shopping', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }));
  expectedErrors.push(/404/);
  await page.getByRole('button', { name: 'Shopping list' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(/Shopping lists aren't available right now/).waitFor();
  await dialog.getByText('Produce', { exact: true }).waitFor();
  const text = await dialog.innerText();
  assert.match(text, /Eggs\s*3/, 'bare counts are pluralised');
  assert.match(text, /Penne pasta\s*400 g/);
  assert.doesNotMatch(text, /warm water/, 'water is not a shopping item');
  assert.match(text, /Butter\s*78 g/, 'butter in tbsp and g merged');
  assert.equal(await dialog.getByRole('button', { name: /^Add \d+ items/ }).count(), 0);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await page.getByText('Shopping list copied').waitFor();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /Shopping for/);
  assert.match(clip, /penne pasta/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.unroute('**/api/lists?type=shopping');
});

await check('real push into a real Lists list: canonical aisles, quantity chips, no duplicates', async () => {
  const aisles = ['Produce', 'Bakery', 'Dairy', 'Meat', 'Pantry', 'Frozen', 'Drinks', 'Snacks', 'Household', 'Personal care', 'Other'];
  const list = await api(page, 'POST', '/api/lists', { name: `E2E Groceries ${TAG}`, type: 'shopping' });
  assert.equal(list.status, 201, JSON.stringify(list.body));
  createdLists.push(list.body.id);
  // Already on the list before we start: must be detected and left unticked.
  const pre = await api(page, 'POST', `/api/lists/${list.body.id}/items`, { text: 'Eggs', quantity: '6' });
  assert.equal(pre.status, 201, JSON.stringify(pre.body));
  const pre2 = await api(page, 'POST', `/api/lists/${list.body.id}/items`, { text: 'Tortillas', quantity: null });
  assert.equal(pre2.status, 201, JSON.stringify(pre2.body));

  await page.getByRole('button', { name: 'Shopping list' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Add to').selectOption(String(list.body.id));
  await dialog.getByText(/2 ingredients already on this list/).waitFor(); // Eggs, and Tortillas ≈ Small tortillas
  const eggs = dialog.getByRole('checkbox', { name: '3 eggs' });
  assert.equal(await eggs.isChecked(), false, 'eggs already on the list are unticked');
  await dialog.locator('li').filter({ hasText: 'On list · 6' }).filter({ hasText: /^Eggs/ }).waitFor();
  const headers = await dialog.locator('section h3').allInnerTexts();
  assert.ok(headers.every((h) => aisles.map((x) => x.toUpperCase()).includes(h.toUpperCase())), `dialog aisles: ${headers}`);
  await page.waitForTimeout(300);
  await dialog.getByRole('checkbox', { name: '400 g penne pasta' }).evaluate((el) => el.click()); // untick one more
  assert.equal(await dialog.getByRole('checkbox', { name: '400 g penne pasta' }).isChecked(), false);
  const total = await dialog.getByRole('checkbox').count();
  await shot(page, 'desktop-light-shopping-real');
  await dialog.getByRole('button', { name: `Add ${total - 3} items` }).click();
  await page.getByText(new RegExp(`Added ${total - 3} items to E2E Groceries ${TAG}`)).waitFor();
  await dialog.getByText('Added').first().waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'All added' }).isDisabled(), 'nothing left to add until something is ticked again');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  const after = (await api(page, 'GET', `/api/lists/${list.body.id}`)).body.items;
  const find = (t) => after.filter((i) => i.text === t);
  assert.equal(find('Butter').length, 1);
  assert.deepEqual([find('Butter')[0].quantity, find('Butter')[0].category], ['78 g', 'Dairy'], 'amount travels as the quantity chip');
  assert.equal(find('Small tortillas').length, 0, 'tortillas were already on the list');
  assert.equal(find('Tortillas').length, 1);
  assert.deepEqual([find('Spinach')[0].quantity, find('Spinach')[0].category], ['2 cups', 'Produce']);
  assert.equal(find('Blueberries')[0].category, 'Produce');
  assert.equal(find('Eggs').length, 1, 'no duplicate eggs');
  assert.equal(find('Penne pasta').length, 0, 'unticked items are not added');
  assert.ok(after.every((i) => aisles.includes(i.category)), `list aisles: ${[...new Set(after.map((i) => i.category))]}`);

  // Pressing again: everything already there is flagged and unticked; only the pasta remains.
  await page.getByRole('button', { name: 'Shopping list' }).first().click();
  await dialog.getByLabel('Add to').selectOption(String(list.body.id));
  await dialog.getByRole('button', { name: 'Add 1 item' }).waitFor();
  await dialog.getByRole('button', { name: 'Add 1 item' }).click();
  await page.getByText(new RegExp(`Added 1 item to E2E Groceries ${TAG}`)).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const final = (await api(page, 'GET', `/api/lists/${list.body.id}`)).body.items;
  assert.equal(final.length, after.length + 1, 'second press added only the pasta');
  assert.equal(new Set(final.map((i) => i.text)).size, final.length, 'no duplicate items');

  // And it renders in Lists: canonical aisle section with the quantity chip.
  await page.goto(`${BASE}/lists/${list.body.id}`);
  await page.getByText('Butter', { exact: true }).waitFor();
  await page.getByText('78 g', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Dairy & Eggs|Meat & Fish|Spices/i).count(), 0, 'no look-alike aisles in Lists');
  await shot(page, 'desktop-light-lists-after-push');
  await page.goto(`${BASE}/meals?week=${SRC}`);
  await page.getByRole('button', { name: new RegExp(pastaTitle) }).waitFor();
});

await check('shopping list shows a friendly error when the bulk add fails', async () => {
  await page.route('**/api/lists?type=shopping', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 7, name: 'Groceries', type: 'shopping' }]) }));
  await page.route('**/api/lists/7/items/bulk', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'List is locked' }) }));
  expectedErrors.push(/500/);
  await page.getByRole('button', { name: 'Shopping list' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Add \d+ items/ }).click();
  await page.getByText(/Couldn't add to the list: List is locked/).waitFor();
  assert.ok(await dialog.isVisible(), 'dialog stays open');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/lists?type=shopping');
  await page.unroute('**/api/lists/7/items/bulk');
});

await check('shopping dialog defaults to today onward on the current week; whole week / pick days change the count', async () => {
  const todayKey = key(new Date());
  const days = Math.round((new Date(`${addDays(thisMonday, 6)}T12:00:00`) - new Date(`${todayKey}T12:00:00`)) / 864e5) + 1;
  const fromToday = (await api(page, 'GET', `/api/meals/plan/ingredients?start=${todayKey}&days=${days}`)).body;
  const week = (await api(page, 'GET', `/api/meals/plan/ingredients?start=${thisMonday}&days=7`)).body;
  await page.goto(`${BASE}/meals`);
  const shop = page.getByRole('button', { name: 'Shopping list' }).first();
  await shop.waitFor();
  if (!(await shop.isEnabled())) return; // nothing planned this week on this instance
  await shop.click();
  const dialog = page.getByRole('dialog');
  const recipes = (n) => new RegExp(`^${n} recipes? planned for`);
  if (todayKey !== thisMonday) {
    assert.equal(await dialog.getByRole('radio', { name: 'From today' }).getAttribute('aria-checked'), 'true', 'From today is the default');
    await dialog.getByText(recipes(fromToday.meal_count)).waitFor();
    if (fromToday.items.length) await dialog.getByText(new RegExp(`of ${fromToday.items.length} selected`)).waitFor();
  } else {
    assert.equal(await dialog.getByRole('radio', { name: 'From today' }).count(), 0, 'no From today on Monday');
  }
  await dialog.getByRole('radio', { name: 'Whole week' }).click();
  await dialog.getByText(recipes(week.meal_count)).waitFor();
  if (week.items.length) await dialog.getByText(new RegExp(`of ${week.items.length} selected`)).waitFor();
  await dialog.getByRole('radio', { name: 'Pick days' }).click();
  await dialog.getByLabel('From', { exact: true }).selectOption(thisMonday);
  await dialog.getByLabel('To', { exact: true }).selectOption(thisMonday);
  const monday = (await api(page, 'GET', `/api/meals/plan/ingredients?start=${thisMonday}&days=1`)).body;
  await dialog.getByText(recipes(monday.meal_count)).waitFor();
  await shot(page, 'desktop-light-shopping-range');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
});

// ---------------------------------------------------------------------------------------------
await check('recipe box: search, tag filter, favorite (optimistic + live)', async () => {
  await page.getByRole('tab', { name: 'Recipes' }).click();
  await page.waitForURL('**/meals/recipes');
  await page.getByLabel('Search recipes').fill(TAG);
  await page.waitForFunction(() => document.querySelectorAll('a[href^="/meals/recipes/"]').length === 2);
  await page.getByLabel('Search recipes').fill('');
  await page.goto(`${BASE}/meals/recipes?tag=lunch`);
  await page.getByRole('link', { name: new RegExp(saladTitle) }).waitFor();
  assert.equal(await page.getByRole('link', { name: new RegExp(pastaTitle) }).count(), 0);
  await page.goto(`${BASE}/meals/recipes?q=${TAG}`);
  await sam.page.goto(`${BASE}/meals/recipes/${pasta.id}`);
  await sam.page.getByRole('heading', { name: pastaTitle }).waitFor();
  await page.getByLabel('Search recipes').fill(TAG);
  await page.getByRole('button', { name: `Add ${pastaTitle} to favorites` }).click();
  await page.getByRole('button', { name: `Remove ${pastaTitle} from favorites` }).waitFor();
  await sam.page.getByText(/Loved by Alex/).waitFor({ timeout: 5000 });
  await page.goto(`${BASE}/meals/recipes?fav=1`);
  await page.getByRole('link', { name: new RegExp(pastaTitle) }).waitFor();
});

let createdId = null;
const shrimp = `Lemon Garlic Shrimp ${TAG}`;
await check('create a recipe with pasted ingredients; it appears live elsewhere', async () => {
  await sam.page.goto(`${BASE}/meals/recipes?q=${TAG}`);
  await sam.page.getByRole('link', { name: new RegExp(pastaTitle) }).waitFor();
  await page.goto(`${BASE}/meals/recipes`);
  await page.getByRole('button', { name: 'New recipe' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Recipe name').fill(shrimp);
  await dialog.getByLabel('Description').fill('Bright, garlicky and quick.');
  await dialog.getByLabel('Prep (min)').fill('5');
  await dialog.getByLabel('Add a tag').fill(`e2e-${TAG}`);
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Paste a list' }).click();
  await dialog.getByLabel('Paste ingredients, one per line').fill('500 g shrimp, peeled\n3 cloves garlic\n2 tbsp butter\n3 lemon\n½ cup parsley\n1/2 cup parmesan\n2 jalapeño');
  await dialog.getByRole('button', { name: 'Add ingredients' }).click();
  assert.equal(await dialog.getByLabel('Ingredient 5', { exact: true }).inputValue(), 'parsley');
  assert.equal(await dialog.getByLabel('Ingredient 6', { exact: true }).inputValue(), 'parmesan', '"1/2 cup parmesan" parses the fraction');
  assert.equal(await dialog.getByLabel('Amount for ingredient 6').inputValue(), '½');
  // Typing a plain fraction into the amount field stores the right number.
  await dialog.getByLabel('Amount for ingredient 3').fill('1 1/2');
  await dialog.getByLabel('Amount for ingredient 2').fill('3/4');
  await dialog.getByLabel('Amount for ingredient 2').blur();
  await dialog.getByLabel('Step 1', { exact: true }).fill('Melt the butter and sizzle the garlic for 1 minute.');
  await dialog.getByLabel('Step 2', { exact: true }).fill('Marinate for 1 hour 30 minutes, then cook the shrimp.');
  await shot(page, 'desktop-light-editor-filled');
  await dialog.getByRole('button', { name: 'Save recipe' }).click();
  await page.waitForURL(/\/meals\/recipes\/\d+$/);
  createdId = Number(page.url().split('/').pop());
  created.push(createdId);
  await page.getByRole('heading', { name: shrimp }).waitFor();
  await page.getByRole('checkbox', { name: /500 g shrimp/ }).waitFor();
  await page.getByRole('checkbox', { name: /3 lemons/ }).waitFor();
  await page.getByRole('checkbox', { name: /2 jalapeños/ }).waitFor();
  await page.getByRole('checkbox', { name: /½ cup parmesan/ }).waitFor();
  const saved = (await api(page, 'GET', `/api/meals/recipes/${createdId}`)).body.ingredients;
  assert.deepEqual(saved.map((i) => i.quantity), [500, 0.75, 1.5, 3, 0.5, 0.5, 2]);
  await sam.page.getByRole('link', { name: new RegExp(shrimp) }).waitFor({ timeout: 5000 });
});

await check('recipe detail: servings scale amounts; empty stat tiles hidden', async () => {
  const text = await page.locator('dl').innerText();
  assert.doesNotMatch(text, /COOK|Cook\n/i, 'no cook time → no Cook tile');
  assert.doesNotMatch(text, /—/);
  for (let i = 0; i < 4; i++) await page.getByRole('group', { name: 'Servings' }).getByRole('button', { name: 'More servings' }).click();
  await page.getByRole('checkbox', { name: /1 kg shrimp/ }).waitFor();
  await page.getByRole('checkbox', { name: /6 lemons/ }).waitFor();
});

await check('cook mode: compound timers persist, keyboard steps, finish', async () => {
  await page.getByRole('link', { name: 'Start cooking' }).click();
  await page.waitForURL(/\/cook/);
  const cook = page.getByRole('dialog', { name: /Cook mode/ });
  await cook.getByText('Step 1').waitFor();
  await cook.getByRole('checkbox', { name: /shrimp/ }).check({ force: true });
  await page.keyboard.press('ArrowRight'); // arrows still work after ticking an ingredient
  await cook.getByText('Step 2').waitFor();
  await cook.getByRole('button', { name: 'Start 1:30:00 timer' }).click();
  await cook.getByRole('button', { name: /Timer Step 2 · 1 hour 30 minutes/ }).waitFor();
  await shot(page, 'desktop-light-cook-mode');
  await page.locator('[data-toaster="top"]').waitFor({ state: 'attached' }); // cook mode moves toasts to the top
  await cook.getByRole('button', { name: 'Exit cook mode' }).click();
  await page.getByRole('link', { name: 'Start cooking' }).click();
  await page.getByRole('dialog', { name: /Cook mode/ }).getByRole('button', { name: /Timer Step 2 · 1 hour 30 minutes/ }).waitFor();
  await page.getByRole('dialog', { name: /Cook mode/ }).getByRole('button', { name: /Timer Step 2/ }).click(); // dismiss
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('heading', { name: 'Time to eat!' }).waitFor();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForURL(new RegExp(`/meals/recipes/${createdId}$`));
});

await check("children can't edit others' recipes or copy/clear weeks", async () => {
  const mia = await newPage({ email: 'mia@hearth.test' });
  await mia.page.goto(`${BASE}/meals/recipes/${createdId}`);
  await mia.page.getByRole('heading', { name: shrimp }).waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Recipe actions' }).count(), 0);
  await mia.page.goto(`${BASE}/meals?week=${SRC}`);
  await mia.page.getByRole('grid').waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Copy last week' }).count(), 0);
  assert.equal(await mia.page.getByRole('button', { name: 'Week actions' }).count(), 0);
  await mia.page.getByRole('button', { name: new RegExp(pastaTitle) }).click();
  await mia.page.getByRole('dialog').getByText(/ask a grown-up/).waitFor();
  assert.equal(await mia.page.getByRole('dialog').getByRole('button', { name: 'Save' }).count(), 0);
  await mia.ctx.close();
});

await check('edit and delete a recipe (live for others)', async () => {
  await sam.page.goto(`${BASE}/meals/recipes/${createdId}`);
  await sam.page.getByRole('heading', { name: shrimp }).waitFor();
  await page.getByRole('button', { name: 'Recipe actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit recipe' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Recipe name').fill(`${shrimp} with a very long title that has to wrap onto more than one line nicely`);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await sam.page.getByRole('heading', { name: /very long title/ }).waitFor({ timeout: 5000 });
  const h = await page.getByRole('heading', { name: /very long title/ }).evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(h > 40, `long title wraps (height ${h})`);
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await shot(page, 'desktop-light-detail-long-title');
  await page.getByRole('button', { name: 'Recipe actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete recipe' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete recipe' }).click();
  await page.waitForURL('**/meals/recipes');
  await sam.page.getByText('Recipe not found').waitFor({ timeout: 5000 });
});

await check('recipe not found and dashboard contract', async () => {
  await page.goto(`${BASE}/meals/recipes/999999999`);
  await page.getByText('Recipe not found').waitFor();
  const dash = await api(page, 'GET', '/api/dashboard');
  assert.ok(Array.isArray(dash.body.meals.today));
  assert.ok(dash.body.meals.today.every((m) => m.slot && m.title));
});

await check('mobile planner opens on today and marks it apart from the selected day', async () => {
  const { ctx, page: p } = await newPage({ mobile: true });
  await p.goto(`${BASE}/meals`);
  await p.getByRole('tablist', { name: 'Jump to day' }).waitFor();
  await p.waitForTimeout(600);
  const todayTab = p.getByRole('tab', { name: /\(today\)/ });
  assert.equal(await todayTab.getAttribute('aria-selected'), 'true');
  const todayKey = key(new Date());
  if (todayKey !== thisMonday) {
    // Today's card is on screen without the page auto-scrolling past the header / week controls
    // (earlier days are folded into one row).
    const y = await p.locator(`#meals-day-${todayKey}`).evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(y < 844 - 200, `today's card is in view (top ${y})`);
    assert.equal(await p.evaluate(() => window.scrollY), 0, 'page not auto-scrolled');
    assert.ok(await p.getByRole('button', { name: 'Previous week' }).isVisible(), 'week controls visible');
    await p.getByRole('button', { name: /^Earlier this week/ }).waitFor();
    const strip = await p.getByRole('tablist', { name: 'Jump to day' }).evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.doesNotMatch(strip, /rgba\(.*,\s*0(\.\d+)?\)$/, `sticky day strip is opaque (${strip})`);
    await p.getByRole('tab', { name: new RegExp(`^${weekday(thisMonday)}`) }).click();
    await p.waitForTimeout(500);
    assert.equal(await todayTab.getAttribute('aria-selected'), 'false');
  }
  for (const b of await p.getByRole('button', { name: /^Add (breakfast|lunch|dinner|snack|dish)/ }).all()) {
    const box = await b.boundingBox();
    if (box) assert.ok(box.height >= 44, `tap target ${box.height}px`);
  }
  const wa = await p.getByRole('button', { name: 'Week actions' }).boundingBox();
  assert.ok(wa.height >= 44 && wa.width >= 44);
  await p.goto(`${BASE}/meals/recipes`);
  const heart = await p.getByRole('button', { name: /to favorites|from favorites/ }).first().boundingBox();
  assert.ok(heart.width >= 44 && heart.height >= 44, `favorite heart hit area ${heart.width}×${heart.height}`);
  const chips = p.getByRole('group', { name: 'Filter recipes' }).getByRole('button');
  await chips.first().waitFor();
  for (const c of (await chips.all()).slice(0, 4)) assert.ok((await c.boundingBox()).height >= 44, 'filter chips are 44px tall');
  await ctx.close();
});
await sam.ctx.close();
// Remove our fixtures before taking the gallery screenshots.
for (const id of created.splice(0)) await api(page, 'DELETE', `/api/meals/recipes/${id}`);
for (const id of createdLists.splice(0)) await api(page, 'DELETE', `/api/lists/${id}`);
for (const w of [SRC, DST]) await api(page, 'DELETE', `/api/meals/plan?start=${w}&days=7`);

// ---------------------------------------------------------------------------------------------
// Screenshots of every main screen and dialog: desktop/mobile × light/dark (uses whatever data exists).
const detailId = await (async () => {
  const list = await api(page, 'GET', '/api/meals/recipes?sort=popular');
  return (list.body.find((r) => r.photo_url) ?? list.body[0]).id;
})();
const iconOnlyId = (await api(page, 'GET', '/api/meals/recipes')).body.find((r) => !r.photo_url)?.id;

for (const mobile of [false, true]) {
  for (const theme of ['light', 'dark']) {
    const tag = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
    await check(`screens render cleanly (${tag})`, async () => {
      const { ctx, page: p } = await newPage({ mobile, theme });
      await p.goto(`${BASE}/meals`);
      await (mobile ? p.getByRole('tablist', { name: 'Jump to day' }) : p.getByRole('grid')).waitFor();
      await p.waitForTimeout(700);
      await noOverflow(p, `${tag} planner`);
      await shot(p, `${tag}-planner`);

      await p.getByRole('button', { name: /^Add (breakfast|lunch|dinner|snack)/ }).first().click();
      await p.getByRole('dialog').waitFor();
      await p.waitForTimeout(400);
      await shot(p, `${tag}-plan-dialog`);
      await p.getByRole('dialog').getByRole('radio', { name: 'Something else' }).click();
      await p.waitForTimeout(250);
      await shot(p, `${tag}-plan-dialog-freetext`);
      await p.keyboard.press('Escape');
      await p.getByRole('dialog').waitFor({ state: 'detached' });

      const entry = mobile ? p.locator('[id^=meals-day-] li button').first() : p.locator('[role=gridcell] button[draggable="true"]').first();
      if (await entry.count()) {
        await entry.click();
        await p.getByRole('dialog').waitFor();
        await p.waitForTimeout(400);
        await shot(p, `${tag}-plan-dialog-edit`);
        await p.keyboard.press('Escape');
        await p.getByRole('dialog').waitFor({ state: 'detached' });
      }

      const shop = p.getByRole('button', { name: 'Shopping list' }).first();
      if (await shop.isEnabled()) {
        await shop.click();
        await p.getByRole('dialog').waitFor();
        await p.waitForTimeout(700);
        await shot(p, `${tag}-shopping`);
        await p.keyboard.press('Escape');
        await p.getByRole('dialog').waitFor({ state: 'detached' });
      }

      await p.goto(`${BASE}/meals?week=${DST}`);
      await p.getByText('A fresh week to plan').waitFor();
      await p.waitForTimeout(300);
      await shot(p, `${tag}-empty-week`);

      await p.goto(`${BASE}/meals/recipes`);
      await p.locator('a[href^="/meals/recipes/"]').first().waitFor();
      await p.waitForTimeout(700);
      await noOverflow(p, `${tag} recipes`);
      await shot(p, `${tag}-recipes`);

      await p.getByRole('button', { name: 'New recipe' }).first().click();
      await p.getByRole('dialog').getByLabel('Recipe name').waitFor();
      await p.waitForTimeout(400);
      await shot(p, `${tag}-editor`);
      await p.keyboard.press('Escape');
      await p.getByRole('dialog').waitFor({ state: 'detached' });

      for (const [id, name] of [[detailId, 'detail'], [iconOnlyId, 'detail-icon']]) {
        if (!id) continue;
        await p.goto(`${BASE}/meals/recipes/${id}`);
        await p.getByRole('link', { name: 'Start cooking' }).waitFor();
        await p.waitForTimeout(500);
        await noOverflow(p, `${tag} ${name}`);
        await shot(p, `${tag}-${name}`);
      }
      await p.evaluate(() => window.scrollTo(0, 800));
      await p.waitForTimeout(300);
      await shot(p, `${tag}-detail-scrolled`);

      await p.goto(`${BASE}/meals/recipes/${detailId}/cook`);
      await p.getByRole('dialog', { name: /Cook mode/ }).getByText('Step 1').waitFor();
      await p.waitForTimeout(300);
      await shot(p, `${tag}-cook`);
      if (mobile) {
        await p.getByRole('radio', { name: /Ingredients/ }).click();
        await p.waitForTimeout(200);
        await shot(p, `${tag}-cook-ingredients`);
      }
      await ctx.close();
    });
  }
}

// Empty states (a brand-new family with no recipes / no plan).
await check('empty states for a brand-new family', async () => {
  const email = `meals-empty-${Date.now()}@example.test`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(`empty: ${e.message}`));
  const reg = await p.request.post(`${BASE}/api/auth/register`, { data: { name: 'Nia Empty', email, password: 'secret123', family_name: 'Empty Nest' } });
  assert.equal(reg.status(), 201);
  await p.goto(`${BASE}/meals/recipes`);
  await p.getByText('Start your family recipe box').waitFor();
  await shot(p, 'desktop-light-recipes-empty');
  await p.goto(`${BASE}/meals`);
  await p.getByText('A fresh week to plan').waitFor();
  await p.getByRole('button', { name: /^Add dinner on Monday/ }).click();
  await p.getByRole('dialog').getByLabel("What's on the menu?").waitFor();
  await shot(p, 'desktop-light-plan-dialog-no-recipes');
  await ctx.close();
});

// Cleanup
for (const id of created) await api(page, 'DELETE', `/api/meals/recipes/${id}`);
for (const w of [SRC, DST]) await api(page, 'DELETE', `/api/meals/plan?start=${w}&days=7`);
await alex.ctx.close();
await browser.close();
if (pageErrors.length) {
  console.error('Page errors:\n' + pageErrors.join('\n'));
  process.exit(1);
}
console.log(`\n${passed} checks passed. Screenshots in ${SHOTS}`);
