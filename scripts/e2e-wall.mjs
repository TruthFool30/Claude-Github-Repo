// Home / wall browser smoke test + screenshots.
//   BASE=http://localhost:4201 SHOTS=/tmp/wall-shots node scripts/e2e-wall.mjs
// Needs a freshly seeded instance (npm run seed) with HEARTH_RATE_LIMITS=off.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4201';
const SHOTS = process.env.SHOTS || '/tmp/wall-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const consoleErrors = [];
let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2, '0')} ${msg}`);

async function open(email, { width = 1280, height = 800, theme = 'light', mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => {
    localStorage.setItem('hearth-theme', t);
    localStorage.removeItem('hearth-wall-filter');
    localStorage.removeItem('hearth-wall-draft');
  }, theme);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource.*(404|401)/.test(m.text())) consoleErrors.push(`[${email} ${width}] ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${email} ${width}] pageerror ${e.message}`));
  if (email) {
    const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
    assert.equal(res.status(), 200, `login ${email}`);
  }
  return { ctx, page };
}

const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
async function noHorizontalOverflow(page, label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw + 1, `${label}: horizontal overflow (${sw} > ${iw})`);
}
async function gotoHome(page) {
  await page.goto(`${BASE}/home`);
  await page.getByRole('region', { name: 'Family feed' }).waitFor();
  await page.locator('article').first().waitFor({ timeout: 10_000 });
}

/** A colorful PNG generated in the browser (so uploads look like photos). */
async function makePng(page, hue) {
  const b64 = await page.evaluate((h) => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 600;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 900, 600);
    grad.addColorStop(0, `hsl(${h} 80% 60%)`);
    grad.addColorStop(1, `hsl(${(h + 60) % 360} 80% 45%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath();
    g.arc(650, 180, 90, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/png').split(',')[1];
  }, hue);
  return { name: `photo-${hue}.png`, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

function mockDashboard() {
  const at = (h, m = 0, dayOffset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const key = (off) => {
    const d = new Date();
    d.setDate(d.getDate() + off);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return {
    calendar: {
      today: [
        { id: 1, title: 'School drop-off', start: at(8), end: at(8, 30), all_day: false, color: '#0090FF', location: 'Lincoln Elementary' },
        { id: 2, title: 'Soccer practice — Mia', start: at(16, 30), end: at(18), all_day: false, color: '#30A46C', location: 'Riverside Park' },
        { id: 3, title: 'Family dinner', start: at(18, 45), end: at(20), all_day: false, color: '#F76B15', location: null },
      ],
      upcoming: [
        { id: 4, title: 'Dentist — Leo', start: at(10, 0, 1), end: at(11, 0, 1), all_day: false, color: '#E5484D', location: 'Bright Smiles' },
        { id: 5, title: 'Piano lesson', start: at(17, 0, 2), end: at(18, 0, 2), all_day: false, color: '#8E4EC6', location: null },
        { id: 6, title: 'Grandparents arrive ✈️', start: key(3), end: null, all_day: true, color: '#5B5BD6', location: null },
      ],
    },
    lists: {
      overdue: [{ id: 11, list_id: 2, list_name: 'Weekend chores', text: 'Return library books', due_date: key(-1), assignee_id: 3 }],
      due: [
        { id: 12, list_id: 3, list_name: 'To-do', text: 'Buy a birthday card for Grandma', due_date: key(0), assignee_id: 2 },
        { id: 13, list_id: 2, list_name: 'Weekend chores', text: 'Take out the recycling', due_date: key(0), assignee_id: 4 },
      ],
      lists: [
        { id: 1, name: 'Groceries', type: 'shopping', open_count: 7 },
        { id: 2, name: 'Weekend chores', type: 'todo', open_count: 3 },
        { id: 3, name: 'Packing list', type: 'other', open_count: 12 },
      ],
    },
    meals: {
      today: [
        { slot: 'breakfast', title: 'Blueberry pancakes' },
        { slot: 'lunch', title: 'Turkey & avocado wraps' },
        { slot: 'dinner', title: 'Chicken tacos with mango salsa', recipe_id: 4 },
      ],
    },
  };
}

console.log(`Wall e2e against ${BASE} → screenshots in ${SHOTS}`);

// ---------- desktop: Alex (light) + Sam (second browser, live) ----------
const alex = await open('alex@hearth.test');
const sam = await open('sam@hearth.test', { theme: 'dark' });
const A = alex.page;
const S = sam.page;

// Real cross-module activity through the other modules' APIs (the seed already holds plenty;
// these are fresh entries with known text for the feed / Updates filter checks).
const apiJson = async (page, method, url, data) => {
  const res = await page.request.fetch(`${BASE}${url}`, { method, data });
  assert.ok(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`);
  return res.json();
};
{
  const lists = await apiJson(S, 'GET', '/api/lists');
  const groceries = lists.find((l) => l.name === 'Groceries');
  const todo = lists.find((l) => l.type !== 'shopping');
  assert.ok(groceries && todo, 'seeded Groceries and a to-do list exist');
  await apiJson(S, 'POST', `/api/lists/${groceries.id}/items/bulk`, { items: ['Oat milk', 'Bananas', 'Rice', 'Coffee beans'].map((text) => ({ text })) });
  await apiJson(A, 'POST', `/api/lists/${todo.id}/items/bulk`, { items: [{ text: 'Feed the cat' }] });
}
const dash = await apiJson(A, 'GET', '/api/dashboard');

await gotoHome(A);
await A.getByRole('heading', { name: /Good (morning|afternoon|evening|night), Alex/ }).waitFor();
assert.ok(await A.getByText(/Pinned by/).first().isVisible(), 'pinned post shown');
await A.getByText('Grandma & Grandpa land Friday', { exact: false }).first().waitFor();
// Real module data in the glance cards (no "get started" fallbacks: every module has a dashboard).
{
  const region = (name) => A.locator('aside[aria-label="At a glance"]').getByRole('region', { name });
  await region('Today').waitFor();
  if (dash.calendar?.today?.length) await region('Today').getByText(dash.calendar.today[0].title, { exact: false }).first().waitFor();
  const task = dash.lists?.overdue?.[0] ?? dash.lists?.due?.[0];
  if (task) await region('Tasks due').getByText(task.text, { exact: false }).first().waitFor();
  if (dash.meals?.today?.length) await region('On the menu').getByText(dash.meals.today[0].title, { exact: false }).first().waitFor();
  await region('Birthdays').getByText(/^Next: /).waitFor();
  assert.ok(dash.calendar && dash.lists && dash.meals, 'calendar, lists and meals dashboards are present');
  assert.ok(dash.calendar.today.length + dash.calendar.upcoming.length > 0, 'seeded calendar events');
  for (const fallback of ['Plan your week together', 'Share the to-dos', 'Plan the week of meals', 'Never miss a birthday']) {
    assert.equal(await A.getByText(fallback).count(), 0, `no "${fallback}" fallback with real modules`);
  }
}
// activity from other modules is rendered with module labels
await A.getByText('added 4 items to Groceries').first().waitFor();
assert.equal(await A.getByRole('button', { name: 'New post', exact: true }).count(), 1, 'one "New post" entry point (no FAB on Home)');
await noHorizontalOverflow(A, 'desktop home');
await shot(A, 'desktop-light-home');
await shot(A, 'desktop-light-home-full', { fullPage: true });
log('home renders greeting, pinned post, real glance cards, cross-module activity');

// full dashboard state via a mocked /api/dashboard
await A.route('**/api/dashboard', (r) => r.fulfill({ json: mockDashboard() }));
await A.reload();
await A.getByText('Soccer practice — Mia').first().waitFor();
await A.getByText('Chicken tacos with mango salsa').first().waitFor();
await A.getByText('Return library books').first().waitFor();
await A.getByText(/3 events today/).waitFor();
await shot(A, 'desktop-light-home-dashboard');
log('dashboard cards show calendar / lists / meals data when present');

await gotoHome(S);
let samFeedFetches = 0;
S.on('request', (r) => {
  if (r.url().includes('/api/wall/feed')) samFeedFetches++;
});

// ---------- composer: mention, mood, photos, post ----------
await A.getByRole('button', { name: /What's new, Alex/ }).click();
const dialog = A.getByRole('dialog', { name: 'Share with the family' });
await dialog.waitFor();
const text = dialog.getByRole('combobox', { name: 'Post text' });
await text.fill('Pizza night was a hit! Thanks @');
await text.press('End');
await text.type('Sa');
const opt = A.getByRole('option', { name: /Sam/ });
await opt.waitFor();
{
  const box = await opt.boundingBox();
  const vp = A.viewportSize();
  assert.ok(box && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width, 'mention list fully on screen');
  const hit = await A.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role=option]')?.textContent ?? '', { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.match(hit, /Sam/, 'mention option is not covered/clipped');
}
await shot(A, 'desktop-light-composer-mention');
await text.press('Enter');
await text.type('for the dough 🍕');
assert.equal(await text.inputValue(), 'Pizza night was a hit! Thanks @Sam for the dough 🍕');
await dialog.getByRole('button', { name: /Feeling|Mood/ }).click();
await A.getByRole('option', { name: /happy/ }).first().waitFor();
await shot(A, 'desktop-light-composer-mood');
await A.getByRole('option', { name: /grateful/ }).click();
await dialog.getByText('is feeling').waitFor();
const files = [await makePng(A, 10), await makePng(A, 200), await makePng(A, 280)];
await dialog.locator('input[type=file]').setInputFiles(files);
await dialog.getByRole('button', { name: 'Remove photo' }).nth(2).waitFor();
await shot(A, 'desktop-light-composer');
await dialog.getByRole('button', { name: 'Post', exact: true }).click();
await dialog.waitFor({ state: 'detached' });
const mine = A.locator('article', { hasText: 'Pizza night was a hit!' }).first();
await mine.waitFor();
assert.equal(await mine.locator('img').count(), 3, 'three photos in the new post');
log('composer posts text + @mention + mood + 3 photos');

// live on Sam's screen (no reload)
const samView = S.locator('article', { hasText: 'Pizza night was a hit!' }).first();
await samView.waitFor({ timeout: 8000 });
assert.ok(await samView.getByText('grateful').isVisible());
log('second browser receives the new post live');

// Sam reacts 🎉 → Alex sees it live
await samView.getByRole('button', { name: 'React', exact: true }).click();
await S.getByRole('menuitemradio', { name: 'React with Celebrate' }).click();
await samView.getByRole('button', { name: /You reacted Celebrate/ }).waitFor();
await mine.getByRole('button', { name: /1 reaction: Sam/ }).waitFor({ timeout: 8000 });
log('reaction is optimistic for Sam and live for Alex');

// Sam comments → Alex sees it live; Alex replies
await samView.getByRole('button', { name: 'Comment', exact: true }).click();
const samBox = samView.getByRole('combobox', { name: /Comment on/ });
await samBox.fill('Anytime! Same time next Friday?');
await samBox.press('Enter');
await mine.getByText('Anytime! Same time next Friday?').waitFor({ timeout: 8000 });
await mine.getByRole('button', { name: 'Reply' }).first().click();
const alexBox = mine.getByRole('combobox', { name: 'Write a reply' });
assert.match(await alexBox.inputValue(), /^@Sam /);
await alexBox.type('Deal 🙌');
await alexBox.press('Enter');
await samView.getByText('Deal 🙌').waitFor({ timeout: 8000 });
log('threaded comment + reply delivered live both ways');
assert.equal(samFeedFetches, 0, 'live events patch the cache instead of refetching feed pages');
log('live updates applied without refetching the feed');

// notifications for the author
const notes = await A.request.get(`${BASE}/api/notifications`);
assert.ok((await notes.json()).items.some((n) => n.title === 'Sam commented on your post'));

// reactions modal + reaction picker screenshots
await mine.getByRole('button', { name: /1 reaction/ }).click();
await A.getByRole('dialog', { name: 'Reactions' }).waitFor();
await shot(A, 'desktop-light-reactions-modal');
await A.keyboard.press('Escape');
await mine.getByRole('button', { name: 'React', exact: true }).click();
await A.getByRole('menu', { name: 'Choose a reaction' }).waitFor();
await shot(A, 'desktop-light-reaction-picker');
await A.getByRole('menuitemradio', { name: 'React with Love' }).click();
await mine.getByRole('button', { name: /You reacted Love/ }).waitFor();

// edit own post (remove a photo, change text)
await mine.getByRole('button', { name: 'Post actions' }).click();
await A.getByRole('menuitem', { name: 'Edit post' }).click();
const edit = A.getByRole('dialog', { name: 'Edit post' });
await edit.waitFor();
await edit.getByRole('combobox', { name: 'Post text' }).fill('Pizza night was a hit! Thanks @Sam for the dough 🍕 (and Leo for the toppings)');
await edit.getByRole('button', { name: 'Remove photo' }).first().click();
await shot(A, 'desktop-light-edit');
await edit.getByRole('button', { name: 'Save' }).click();
await edit.waitFor({ state: 'detached' });
await mine.getByText('(and Leo for the toppings)').waitFor();
assert.equal(await mine.locator('img').count(), 2);
await samView.getByText('(and Leo for the toppings)').waitFor({ timeout: 8000 });
log('edit post updates text/photos for both browsers');

// pin it → moves to the top with a banner
await mine.getByRole('button', { name: 'Post actions' }).click();
await A.getByRole('menuitem', { name: 'Pin to top' }).click();
await A.locator('article').first().getByText('Pizza night was a hit!').waitFor({ timeout: 8000 });
log('pinning moves the post to the top');

// lightbox (with every module's seeded activity the 3-day-old hike post may be on a later page)
for (let i = 0; i < 15 && !(await A.locator('article', { hasText: 'Eagle Lake loop' }).count()); i++) {
  await A.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const more = A.getByRole('button', { name: /load more|show more|older/i });
  if (await more.count()) await more.first().click().catch(() => {});
  await A.waitForTimeout(500);
}
await A.locator('article', { hasText: 'Eagle Lake loop' }).getByRole('button', { name: /Open photo 1 of 6/ }).click();
await A.waitForTimeout(400);
await shot(A, 'desktop-light-lightbox');
await A.keyboard.press('Escape');

// filters
await A.getByRole('radio', { name: 'Photos' }).click();
await A.waitForTimeout(600);
assert.equal(await A.locator('article:not(:has(img))').count(), 0, 'photo filter only shows photo posts');
await A.getByRole('radio', { name: 'Updates' }).click();
await A.getByText(/added .Feed the cat. to /).first().waitFor();
assert.equal(await A.locator('article').count(), 0);
await shot(A, 'desktop-light-filter-updates');
await A.getByRole('radio', { name: 'All' }).click();
log('feed filters: photos / updates');

// infinite scroll reaches the end
// (every module's seeded activity makes the feed several pages long: keep scrolling)
for (let i = 0; i < 40 && !(await A.getByText("You're all caught up").count()); i++) {
  await A.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await A.waitForTimeout(400);
}
await A.getByText("You're all caught up").waitFor({ timeout: 10_000 });
log('infinite scroll loads to the end');

// post detail page
const pizzaId = await mine.evaluate((el) => el.querySelector('a[href^="/home/post/"]').getAttribute('href'));
await A.goto(`${BASE}${pizzaId}`);
await A.getByText('Deal 🙌').waitFor();
await shot(A, 'desktop-light-post-detail');
log('post detail page');

// quick add item → friendly fallback (Lists is a stub in this worktree)
await A.goto(`${BASE}/home`);
await A.getByRole('button', { name: 'List item' }).click();
await A.getByRole('dialog', { name: 'Add to a list' }).getByText(/Lists aren't available yet|No lists yet|Item/).first().waitFor();
await shot(A, 'desktop-light-quick-item');
await A.keyboard.press('Escape');
log('quick "list item" action degrades gracefully');

// delete → gone for Sam too
await gotoHome(A);
const mineAgain = A.locator('article', { hasText: 'Pizza night was a hit!' }).first();
await mineAgain.getByRole('button', { name: 'Post actions' }).click();
await A.getByRole('menuitem', { name: 'Delete post' }).click();
const confirmDlg = A.getByRole('dialog').filter({ hasText: 'Delete this post?' });
await confirmDlg.waitFor();
await shot(A, 'desktop-light-delete-confirm');
await confirmDlg.getByRole('button', { name: 'Delete post' }).click();
await mineAgain.waitFor({ state: 'detached' });
await S.locator('article', { hasText: 'Pizza night was a hit!' }).first().waitFor({ state: 'detached', timeout: 8000 });
log('delete removes the post in both browsers');

// Sam desktop dark screenshots
await S.route('**/api/dashboard', (r) => r.fulfill({ json: mockDashboard() }));
await S.reload();
await S.getByText('Soccer practice — Mia').first().waitFor();
await shot(S, 'desktop-dark-home-dashboard');
await S.unroute('**/api/dashboard');
await S.reload();
await S.locator('article').first().waitFor();
await shot(S, 'desktop-dark-home');
await S.getByRole('button', { name: /What's new, Sam/ }).click();
await S.getByRole('dialog', { name: 'Share with the family' }).waitFor();
await S.getByRole('combobox', { name: 'Post text' }).fill('Dark mode check ✨');
await shot(S, 'desktop-dark-composer');
await S.keyboard.press('Escape');

// ---------- child: Mia can't pin or delete others' posts ----------
const mia = await open('mia@hearth.test');
await gotoHome(mia.page);
const samPost = mia.page.locator('article', { hasText: 'Sunset walk on the pier' }).first();
await samPost.getByRole('button', { name: 'Post actions' }).click();
await mia.page.getByRole('menuitem', { name: 'Copy link' }).waitFor();
assert.equal(await mia.page.getByRole('menuitem', { name: /Pin/ }).count(), 0);
assert.equal(await mia.page.getByRole('menuitem', { name: 'Delete post' }).count(), 0);
await mia.page.keyboard.press('Escape');
log('child role: no pin / delete on others\' posts');
await mia.ctx.close();

// ---------- mobile 390×844, light + dark ----------
for (const theme of ['light', 'dark']) {
  const m = await open('alex@hearth.test', { width: 390, height: 844, mobile: true, theme });
  const P = m.page;
  await gotoHome(P);
  await noHorizontalOverflow(P, `mobile ${theme} home`);
  const firstHeader = await P.locator('article header').first().boundingBox();
  assert.ok(firstHeader && firstHeader.y + 40 < 844 - 64, `first post header visible on the first mobile screen (y=${firstHeader?.y})`);
  await shot(P, `mobile-${theme}-home`);
  await P.route('**/api/dashboard', (r) => r.fulfill({ json: mockDashboard() }));
  await P.reload();
  await P.getByText('Soccer practice — Mia').first().waitFor();
  await noHorizontalOverflow(P, `mobile ${theme} dashboard`);
  await shot(P, `mobile-${theme}-home-dashboard`);
  const feedHeight = await P.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(feedHeight < 12000, `mobile first page stays light (${feedHeight}px)`);
  await P.locator('article').nth(1).scrollIntoViewIfNeeded();
  await shot(P, `mobile-${theme}-feed`);
  await P.getByRole('button', { name: 'New post' }).last().click(); // FAB
  const d = P.getByRole('dialog', { name: 'Share with the family' });
  await d.waitFor();
  const mt = d.getByRole('combobox', { name: 'Post text' });
  await mt.fill('From my phone 📱 with @');
  await mt.press('End');
  await mt.type('M');
  const mo = P.getByRole('option', { name: /Mia/ });
  await mo.waitFor();
  const mb = await mo.boundingBox();
  assert.ok(mb && mb.y >= 0 && mb.y + mb.height <= 844, 'mobile mention list visible');
  await P.waitForTimeout(250);
  await shot(P, `mobile-${theme}-composer-mention`);
  await mt.press('Enter');
  await P.waitForTimeout(350);
  await shot(P, `mobile-${theme}-composer`);
  await P.keyboard.press('Escape');
  await d.waitFor({ state: 'detached' });
  const first = P.locator('article', { hasText: 'Sunset walk on the pier' }).first();
  await first.getByRole('button', { name: /^(React|You reacted)/ }).click();
  await P.getByRole('menu', { name: 'Choose a reaction' }).waitFor();
  await shot(P, `mobile-${theme}-reaction-picker`);
  await P.keyboard.press('Escape');
  const href = await first.evaluate((el) => el.querySelector('a[href^="/home/post/"]').getAttribute('href'));
  await P.goto(`${BASE}${href}`);
  await P.getByText('Next time — Thursday looks clear again').waitFor();
  await noHorizontalOverflow(P, `mobile ${theme} post`);
  await shot(P, `mobile-${theme}-post-detail`);
  await m.ctx.close();
  log(`mobile ${theme}: home, dashboard, feed, composer sheet, picker, post detail`);
}

// ---------- empty state: a brand-new family ----------
{
  const fresh = await open(null);
  const email = `fresh${Date.now()}@example.test`;
  const reg = await fresh.page.request.post(`${BASE}/api/auth/register`, { data: { name: 'Jordan Lee', email, password: 'hearth123', family_name: 'Lee Family' } });
  assert.equal(reg.status(), 201);
  await fresh.page.goto(`${BASE}/home`);
  await fresh.page.getByText('Your family wall is ready').waitFor();
  await shot(fresh.page, 'desktop-light-empty');
  await fresh.ctx.close();
  const freshM = await open(null, { width: 390, height: 844, mobile: true, theme: 'dark' });
  await freshM.page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  await freshM.page.goto(`${BASE}/home`);
  await freshM.page.getByText('Your family wall is ready').waitFor();
  await shot(freshM.page, 'mobile-dark-empty', { fullPage: true });
  await freshM.ctx.close();
  log('empty wall for a new family');
}

await alex.ctx.close();
await sam.ctx.close();
await browser.close();

if (consoleErrors.length) {
  console.error('Console errors:\n' + consoleErrors.join('\n'));
  process.exit(1);
}
console.log(`All wall checks passed (${step} steps).`);
