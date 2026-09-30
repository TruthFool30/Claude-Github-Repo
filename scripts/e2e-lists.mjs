// Lists module browser smoke test + screenshots.
//   BASE=http://localhost:4203 SHOTS=/tmp/lists-shots node scripts/e2e-lists.mjs
// Expects a freshly seeded instance (npm run seed) with HEARTH_RATE_LIMITS=off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4203';
const SHOTS = process.env.SHOTS || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'e2e-lists');
fs.mkdirSync(SHOTS, { recursive: true });
// One fixed zone for every browser context AND every API request, so "today", "overdue" and the
// seed's relative due dates line up no matter what zone a user row remembered from a previous run.
// Default: this machine's zone (= the server's when run locally, which is also the zone the demo
// seed uses on a fresh DB). Override with E2E_TZ=<IANA zone> to match a remote server.
const TZ = process.env.E2E_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const TZ_CTX = { timezoneId: TZ, extraHTTPHeaders: { 'X-Timezone': TZ } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let step = '';

async function newUser(email, { width = 1280, height = 800, theme = 'light', mobile = false } = {}) {
  const ctx = await browser.newContext({ ...TZ_CTX, viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  // The deliberate /lists/999999 visit logs the expected 404 response.
  page.on('console', (m) => { if (m.type() === 'error' && step !== '404') errors.push(`[${email} ${step}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email} ${step}] pageerror ${e.message}`));
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert.equal(res.status(), 200, `login ${email}`);
  return { ctx, page };
}

const api = async (page, method, url, data) => {
  const res = await page.request.fetch(`${BASE}/api${url}`, { method, data });
  return res.json();
};
const listIdByName = async (page, name) => (await api(page, 'GET', '/lists')).find((l) => l.name === name).id;
/** Click the visible circle of a shared <Checkbox> (the native input is sr-only). */
const tick = (checkbox) => checkbox.locator('xpath=following-sibling::span').click();
const noHScroll = async (page) => {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert.ok(w[0] <= w[1] + 1, `horizontal overflow ${w[0]} > ${w[1]} at ${step}`);
};

// ---------------------------------------------------------------------------------------------
// 1. Functional flows (desktop, two browsers)
{
  const A = await newUser('alex@hearth.test');
  const B = await newUser('sam@hearth.test');
  const a = A.page;
  const b = B.page;

  step = 'overview';
  await a.goto(`${BASE}/lists`);
  await a.getByRole('link', { name: 'Groceries' }).waitFor();
  assert.ok(await a.getByRole('link', { name: 'Weekend chores' }).isVisible());
  assert.ok(await a.getByRole('region', { name: 'My tasks' }).first().isVisible());
  // Nav badge (overdue + today tasks for Alex).
  const navText = await a.locator('aside a[href="/lists"]').first().innerText();
  assert.match(navText, /\d/, 'lists nav badge shows a count');
  await noHScroll(a);

  step = 'detail';
  const groceries = await listIdByName(a, 'Groceries');
  await a.getByRole('link', { name: 'Groceries' }).click();
  await a.waitForURL(`**/lists/${groceries}`);
  await a.getByRole('region', { name: 'Dairy' }).waitFor();
  await b.goto(`${BASE}/lists/${groceries}`);
  await b.getByRole('region', { name: 'Dairy' }).waitFor();

  step = 'fast add';
  const add = a.getByRole('textbox', { name: 'Add an item' });
  await add.fill('Blueberries x2');
  await a.locator('form [aria-live="polite"]', { hasText: 'Produce' }).waitFor();
  await add.press('Enter');
  await a.getByRole('region', { name: 'Produce' }).getByRole('button', { name: /Blueberries, 2\. Open details/ }).waitFor();
  assert.equal(await add.inputValue(), '');
  assert.ok(await add.evaluate((el) => el === document.activeElement), 'add bar keeps focus');
  await add.fill('Maple syrup');
  await add.press('Enter');
  await a.getByRole('region', { name: 'Pantry' }).getByRole('button', { name: /Maple syrup.*Open details/ }).waitFor();

  step = 'live add';
  await b.getByRole('button', { name: /Blueberries, 2\. Open details/ }).waitFor({ timeout: 5000 });

  step = 'check off';
  await tick(a.getByRole('checkbox', { name: 'Mark “Blueberries” as done' }));
  await a.getByRole('region', { name: 'Completed items' }).getByRole('button', { name: /Blueberries.*Open details/ }).waitFor();
  await b.getByRole('region', { name: 'Completed items' }).getByRole('button', { name: /Blueberries.*Open details/ }).waitFor({ timeout: 5000 });
  const blue = (await api(a, 'GET', `/lists/${groceries}`)).items.find((i) => i.text === 'Blueberries');
  assert.equal(blue.done, true);
  assert.equal(blue.quantity, '2');

  step = 'uncheck';
  await tick(a.getByRole('checkbox', { name: 'Mark “Blueberries” as not done' }));
  await a.getByRole('region', { name: 'Produce' }).getByRole('button', { name: /Blueberries.*Open details/ }).waitFor();

  step = 'item sheet';
  await a.getByRole('button', { name: /Maple syrup\. Open details/ }).click();
  const dialog = a.getByRole('dialog', { name: 'Item details' });
  await dialog.waitFor();
  await dialog.getByLabel('Notes').fill('The real stuff, grade A');
  await dialog.getByLabel('Quantity').fill('1 bottle');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await a.getByRole('button', { name: /Maple syrup, 1 bottle\. Open details/ }).waitFor();
  await b.getByText('The real stuff, grade A').waitFor({ timeout: 5000 });

  step = 'delete + undo';
  const maple = (await api(a, 'GET', `/lists/${groceries}`)).items.find((i) => i.text === 'Maple syrup');
  await a.getByRole('button', { name: /Maple syrup, 1 bottle\. Open details/ }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await b.getByRole('button', { name: /Maple syrup.*Open details/ }).waitFor({ state: 'detached', timeout: 5000 });
  await a.getByRole('button', { name: 'Undo' }).click();
  await a.getByRole('button', { name: /Maple syrup.*Open details/ }).waitFor();
  await b.getByRole('button', { name: /Maple syrup.*Open details/ }).waitFor({ timeout: 5000 });
  const restored = (await api(a, 'GET', `/lists/${groceries}`)).items.filter((i) => i.text === 'Maple syrup');
  assert.equal(restored.length, 1, 'undo restores exactly one row');
  assert.equal(restored[0].id, maple.id, 'undo restores the original row (same id)');
  assert.equal(restored[0].created_at, maple.created_at);
  assert.equal(restored[0].notes, 'The real stuff, grade A');

  step = 'aisle guess';
  await add.fill('Tomato sauce');
  await a.locator('form [aria-live="polite"]', { hasText: 'Pantry' }).waitFor();
  await add.press('Enter');
  await a.getByRole('region', { name: 'Pantry' }).getByRole('button', { name: /Tomato sauce\. Open details/ }).waitFor();
  for (const [text, aisle] of [['Garlic bread', 'Bakery'], ['Peanuts', 'Snacks'], ['Kitchen roll', 'Household']]) {
    await add.fill(text);
    await add.press('Enter');
    await a.getByRole('region', { name: aisle }).getByRole('button', { name: new RegExp(`${text}\\. Open details`) }).waitFor();
  }

  step = 'keyboard reorder';
  const chores = await listIdByName(a, 'Weekend chores');
  await a.goto(`${BASE}/lists/${chores}`);
  const before = (await api(a, 'GET', `/lists/${chores}`)).items.filter((i) => !i.done).map((i) => i.text);
  await a.getByRole('button', { name: `Reorder “${before[0]}”. Use arrow up and down keys to move.` }).focus();
  await a.keyboard.press('ArrowDown');
  await a.waitForFunction(
    async ([id, first]) => {
      const r = await fetch(`/api/lists/${id}`);
      const d = await r.json();
      return d.items.filter((i) => !i.done)[1]?.text === first;
    },
    [chores, before[0]],
  );
  assert.ok(await a.getByRole('button', { name: `Reorder “${before[0]}”. Use arrow up and down keys to move.` }).evaluate((el) => el === document.activeElement));

  step = 'mention assign';
  const addTask = a.getByRole('textbox', { name: 'Add a task' });
  await addTask.fill('@Leo sweep the porch');
  await addTask.press('Enter');
  await a.getByRole('button', { name: /sweep the porch\. Open details/ }).waitFor();
  const sweep = (await api(a, 'GET', `/lists/${chores}`)).items.find((i) => i.text === 'sweep the porch');
  const leo = (await api(a, 'GET', '/family')).members.find((m) => m.name.startsWith('Leo'));
  assert.equal(sweep.assignee_id, leo.id);

  step = 'my tasks';
  await a.goto(`${BASE}/lists/my-tasks`);
  await a.getByRole('region', { name: 'Overdue' }).waitFor();
  await a.getByRole('region', { name: 'Today' }).waitFor();
  const task = a.getByRole('region', { name: 'Today' }).getByRole('checkbox').first();
  const taskLabel = await task.getAttribute('aria-label');
  await tick(task);
  await a.getByRole('button', { name: 'Undo' }).click();
  await a.waitForTimeout(600);
  assert.ok(await a.getByRole('checkbox', { name: taskLabel }).isVisible());

  step = 'create + delete list';
  await a.goto(`${BASE}/lists`);
  await a.getByRole('button', { name: 'New list' }).first().click();
  const form = a.getByRole('dialog', { name: 'New list' });
  await form.getByRole('button', { name: /Packing list/ }).click();
  await form.getByLabel('Name').fill('Camping trip');
  await form.getByRole('button', { name: 'Create list' }).click();
  await a.waitForURL(/\/lists\/\d+$/);
  await a.getByRole('heading', { name: /Camping trip/ }).waitFor();
  await b.goto(`${BASE}/lists`);
  await b.getByRole('link', { name: 'Camping trip' }).waitFor();
  await a.getByRole('button', { name: 'List actions' }).click();
  await a.getByRole('menuitem', { name: 'Delete list' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Delete list' }).click();
  await a.waitForURL(`${BASE}/lists`);
  await b.getByRole('link', { name: 'Camping trip' }).waitFor({ state: 'detached', timeout: 5000 });

  step = 'clear completed';
  const costco = await listIdByName(a, 'Costco run');
  await a.goto(`${BASE}/lists/${costco}`);
  await a.getByRole('region', { name: 'Completed items' }).getByRole('button', { name: 'Clear' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Clear' }).click();
  await a.getByRole('region', { name: 'Completed items' }).waitFor({ state: 'detached' });
  assert.equal((await api(a, 'GET', `/lists/${costco}`)).done_count, 0);

  step = 'child permissions';
  const M = await newUser('mia@hearth.test');
  await M.page.goto(`${BASE}/lists/${groceries}`);
  await M.page.getByRole('region', { name: 'Dairy' }).waitFor();
  await M.page.getByRole('button', { name: 'List actions' }).click();
  assert.equal(await M.page.getByRole('menuitem', { name: 'Delete list' }).count(), 0, 'child cannot delete a parent’s list');
  await M.page.keyboard.press('Escape');
  assert.equal(await M.page.getByRole('button', { name: /^Reorder/ }).count(), 0, 'child sees no drag handles on a parent’s list');
  // Assigned chore: tick + notes only.
  await M.page.goto(`${BASE}/lists/${chores}`);
  await M.page.getByRole('button', { name: /Clean your room\. Open details/ }).click();
  const miaSheet = M.page.getByRole('dialog', { name: 'Task details' });
  await miaSheet.waitFor();
  assert.equal(await miaSheet.locator('input[type=date]').count(), 0, 'no due-date control for an assignee child');
  assert.equal(await miaSheet.getByRole('textbox', { name: /^Task/ }).count(), 0, 'task text is read-only');
  assert.ok(await miaSheet.getByText('Clothes in the hamper, books on the shelf').isVisible(), 'parent notes shown read-only');
  await M.page.waitForTimeout(350);
  await M.page.screenshot({ path: path.join(SHOTS, 'mia-assignee-sheet.png') });
  await miaSheet.getByLabel('Add a note').fill('Almost done, just the closet left');
  await miaSheet.getByRole('button', { name: 'Save' }).click();
  await miaSheet.waitFor({ state: 'hidden' });
  const clean = (await api(M.page, 'GET', `/lists/${chores}`)).items.find((i) => i.text === 'Clean your room');
  assert.match(clean.notes, /^Clothes in the hamper, books on the shelf\n— Mia · .+: Almost done, just the closet left$/, 'kid note is appended, parent note kept');
  await M.page.getByRole('button', { name: 'List actions' }).click();
  await M.page.getByRole('menu').waitFor();
  const lastItem = M.page.getByRole('menu').locator(':scope > div > *').last();
  assert.notEqual(await lastItem.getAttribute('role'), 'separator', 'menu does not end with a divider');
  await M.page.screenshot({ path: path.join(SHOTS, 'mia-menu.png') });
  await M.page.keyboard.press('Escape');
  await M.ctx.close();

  step = 'empty family';
  {
    const ctx = await browser.newContext({ ...TZ_CTX, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[new ${step}] ${m.text()}`); });
    const email = `e2e${Date.now()}@example.test`;
    const reg = await page.request.post(`${BASE}/api/auth/register`, { data: { name: 'Nia Park', email, password: 'secret123', family_name: 'Park Family' } });
    assert.equal(reg.status(), 201);
    await page.goto(`${BASE}/lists`);
    await page.getByText('Start with one tap').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, 'empty-overview-desktop.png') });
    await page.getByRole('button', { name: /Chores/ }).click();
    await page.waitForURL(/\/lists\/\d+$/);
    await page.getByRole('heading', { name: /Chores/ }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'empty-list-desktop.png') });
    await ctx.close();
  }

  step = '404';
  await a.goto(`${BASE}/lists/999999`);
  await a.getByText('List not found').waitFor();

  await A.ctx.close();
  await B.ctx.close();
  console.log('✓ functional flows');
}

// ---------------------------------------------------------------------------------------------
// 2. Screenshots: every main screen + dialogs, desktop + phone, light + dark
{
  const views = [
    { tag: 'desktop', width: 1280, height: 800, mobile: false },
    { tag: 'mobile', width: 390, height: 844, mobile: true },
  ];
  for (const v of views) {
    for (const theme of ['light', 'dark']) {
      const { ctx, page } = await newUser('alex@hearth.test', { ...v, theme });
      const shot = async (name, full = false) => page.screenshot({ path: path.join(SHOTS, `${v.tag}-${theme}-${name}.png`), fullPage: full });
      const groceries = await listIdByName(page, 'Groceries');
      const chores = await listIdByName(page, 'Weekend chores');

      step = `${v.tag}-${theme} overview`;
      await page.goto(`${BASE}/lists`);
      await page.getByRole('link', { name: 'Groceries' }).waitFor();
      await page.waitForTimeout(400);
      await noHScroll(page);
      await shot('overview');
      if (v.mobile) await shot('overview-full', true);

      step = `${v.tag}-${theme} groceries`;
      await page.goto(`${BASE}/lists/${groceries}`);
      await page.getByRole('region', { name: 'Dairy' }).waitFor();
      await page.waitForTimeout(300);
      await noHScroll(page);
      await shot('groceries');
      await page.getByRole('textbox', { name: 'Add an item' }).fill('Oat milk x2');
      await shot('groceries-typing');
      await page.getByRole('textbox', { name: 'Add an item' }).fill('');

      step = `${v.tag}-${theme} item sheet`;
      await page.getByRole('button', { name: /Ice cream\. Open details/ }).click();
      await page.getByRole('dialog', { name: 'Item details' }).waitFor();
      await page.waitForTimeout(400);
      await shot('item-sheet');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });

      step = `${v.tag}-${theme} chores`;
      await page.goto(`${BASE}/lists/${chores}`);
      await page.getByRole('button', { name: /Clean your room\. Open details/ }).waitFor();
      await page.waitForTimeout(300);
      await noHScroll(page);
      await shot('chores');
      await page.getByRole('button', { name: /Due date/ }).first().click();
      await page.getByRole('dialog', { name: 'Due date for new tasks' }).waitFor();
      await shot('due-popover');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Fix the leaky.*Open details/ }).click();
      await page.getByRole('dialog', { name: 'Task details' }).waitFor();
      await page.waitForTimeout(400);
      await shot('task-sheet');
      await page.keyboard.press('Escape');

      step = `${v.tag}-${theme} my tasks`;
      await page.goto(`${BASE}/lists/my-tasks`);
      await page.getByRole('region', { name: 'Overdue' }).waitFor();
      await page.waitForTimeout(300);
      await noHScroll(page);
      await shot('my-tasks');

      step = `${v.tag}-${theme} new list`;
      await page.goto(`${BASE}/lists`);
      await page.getByRole('link', { name: 'Groceries' }).waitFor();
      await page.getByRole('button', { name: 'New list' }).first().click();
      await page.getByRole('dialog', { name: 'New list' }).waitFor();
      await page.waitForTimeout(400);
      await shot('new-list');
      await page.keyboard.press('Escape');

      step = `${v.tag}-${theme} menu`;
      await page.goto(`${BASE}/lists/${groceries}`);
      await page.getByRole('region', { name: 'Dairy' }).waitFor();
      await page.getByRole('button', { name: 'List actions' }).click();
      await page.getByRole('menu').waitFor();
      await shot('list-menu');
      await ctx.close();
    }
  }
  console.log(`✓ screenshots in ${SHOTS}`);
}

await browser.close();
if (errors.length) {
  console.error('Console errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('✓ no console errors');
