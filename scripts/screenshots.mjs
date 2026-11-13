// Marketing screenshots for the README, captured from the demo "Rivera Family" (never real data).
//   npm run build
//   DB_PATH=/tmp/h/hearth.db UPLOAD_DIR=/tmp/h/uploads npm run seed
//   DB_PATH=/tmp/h/hearth.db UPLOAD_DIR=/tmp/h/uploads PORT=4800 HEARTH_RATE_LIMITS=off npm start
//   BASE=http://localhost:4800 npm run screenshots          (OUT=docs/screenshots by default)
// Needs a FRESHLY seeded instance: it imports the synthetic DBS statement in
// server/test/fixtures/statements/dbs.csv, which only works once per database.
// Shots are taken at deviceScaleFactor 2, then cropped/downscaled, given a thin border and rounded
// corners (so they don't melt into GitHub's background) and encoded as WebP inside Chromium — no
// image libraries needed. ONLY=hero,lists,... captures a subset.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';
const TZ = process.env.TZ;
const BASE = process.env.BASE || 'http://localhost:8080';
const OUT = process.env.OUT || fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const MAX_BYTES = 250 * 1024;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
});
const errors = [];
const saved = [];

// Map tiles come from OpenStreetMap; when they can't load (no internet) the app shows its offline
// grid instead. Failed tile requests are not counted as errors.
const TILE_HOST = /tile\.openstreetmap\.org/;

// Hide things that only exist for a moment, and the text caret.
const CALM_CSS = `
  div.pointer-events-none.fixed[class*="z-[70]"] { display: none !important; } /* toasts */
  * { caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none; }
`;

async function open({ viewport, theme = 'light', email = 'alex@hearth.test' }) {
  const mobile = viewport.width < 600;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, timezoneId: TZ, locale: 'en-US' });
  await ctx.addInitScript((t) => window.localStorage?.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || TILE_HOST.test(m.location()?.url || '')) return;
    if (/ERR_FAILED|ERR_TUNNEL/.test(m.text()) && !m.location()?.url?.startsWith(BASE)) return;
    errors.push(`console: ${m.text()} (${m.location()?.url})`);
  });
  const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  if (r.status() !== 200) throw new Error(`login ${email}: HTTP ${r.status()} — is BASE a seeded Hearth with HEARTH_RATE_LIMITS=off?`);
  return { ctx, page, theme, api: (path) => page.request.get(`${BASE}/api${path}`).then((res) => res.json()) };
}

async function go(page, path) {
  await page.goto(`${BASE}${path}`);
  await page.addStyleTag({ content: CALM_CSS });
}

/** Fonts, images and animations done; nothing focused. */
async function settle(page, ms = 900) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(-10, -10).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Chat opens scrolled to the newest message; make sure it is at the very bottom, then hide the
 *  one message sliced in half at the top. */
async function trimChat(page) {
  const log = page.getByRole('log', { name: 'Messages' });
  await page.waitForTimeout(600);
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(400);
  await log.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      if (r.top < top && r.bottom > top) child.style.visibility = 'hidden';
    }
  });
}

/** Hide the smallest element whose text starts with `text` (by walking up `levels` parents). */
const hideByText = (page, text, levels = 0) =>
  page.evaluate(
    ({ text, levels }) => {
      const all = [...document.querySelectorAll('main *')].filter((el) => el.textContent.trim().startsWith(text));
      let el = all.at(-1);
      for (let i = 0; i < levels && el?.parentElement; i++) el = el.parentElement;
      if (el) el.style.display = 'none';
      return Boolean(el);
    },
    { text, levels },
  );

// Desktop feature shots crop away the app's sidebar (264 px) and top bar (64 px + border), so the
// README shows the feature itself at a readable size. Only the hero keeps the whole app frame.
const MAIN = { x: 264, y: 65, width: 1016, height: 735 };
const BORDER = { light: '#d0d7de', dark: '#3d444d' };

// A blank page used to crop, downscale, frame and encode PNGs as WebP with the browser's own encoder.
const conv = await (await browser.newContext()).newPage();
async function save(page, name, width, { clip, theme = 'light', radius = 20, line = 2 } = {}) {
  const png = await page.screenshot({ type: 'png', clip });
  let q = 0.88;
  for (;;) {
    const b64 = await conv.evaluate(
      async ({ data, width, q, radius, line, stroke }) => {
        const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
        const src = await createImageBitmap(blob);
        const w = Math.min(width, src.width);
        const h = Math.round((src.height * w) / src.width);
        const bmp = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext('2d');
        const inset = line / 2;
        g.beginPath();
        g.roundRect(inset, inset, w - line, h - line, radius);
        g.save();
        g.clip();
        g.drawImage(bmp, 0, 0);
        g.restore();
        g.lineWidth = line;
        g.strokeStyle = stroke;
        g.stroke();
        const out = await canvas.convertToBlob({ type: 'image/webp', quality: q });
        const url = await new Promise((res) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.readAsDataURL(out);
        });
        return String(url).split(',')[1];
      },
      { data: png.toString('base64'), width, q, radius, line, stroke: BORDER[theme] },
    );
    const buf = Buffer.from(b64, 'base64');
    if (buf.length <= MAX_BYTES || q <= 0.5) {
      writeFileSync(`${OUT}/${name}.webp`, buf);
      saved.push(name);
      console.log(`  ✓ ${name}.webp ${Math.round(buf.length / 1024)} KB`);
      return;
    }
    q -= 0.06;
  }
}

const want = (key) => !ONLY || ONLY.has(key);
const DESKTOP = { width: 1280, height: 800 };
const HERO = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const FEATURE_WIDTH = 1400; // px of the saved feature image (shown ~950 px wide on GitHub)

// ---- look up demo ids ------------------------------------------------------------------------
const boot = await open({ viewport: DESKTOP });
const lists = await boot.api('/lists');
const groceries = lists.find((l) => l.name === 'Groceries') ?? lists.find((l) => l.type === 'shopping');
const convos = await boot.api('/messages/conversations');
const family = convos.find((c) => c.kind === 'family') ?? convos[0];
const albums = await boot.api('/photos/albums');
const album = albums.find((a) => /Beach/.test(a.title)) ?? albums[0];
const recipes = await boot.api('/meals/recipes');
const recipeList = Array.isArray(recipes) ? recipes : recipes.items ?? recipes.recipes ?? [];
const recipe = recipeList.find((r) => /Creamy Tomato Basil/.test(r.title)) ?? recipeList[0];
await boot.ctx.close();
if (!groceries || !family || !album || !recipe) throw new Error('Demo data not found — run `npm run seed` first.');

// ---- hero: Home, light + dark, whole app frame ---------------------------------------------------
for (const theme of ['light', 'dark']) {
  if (!want('hero')) break;
  const { ctx, page } = await open({ viewport: HERO, theme });
  await go(page, '/home');
  await page.getByText('Family feed').waitFor();
  await settle(page, 1200);
  await save(page, `hero-${theme}`, 1600, { theme, radius: 24 });
  await ctx.close();
}

// ---- desktop feature tour (light, cropped to the page content) ----------------------------------
{
  const { ctx, page } = await open({ viewport: DESKTOP });
  const shoot = async (key, path, ready, prepare) => {
    if (!want(key)) return;
    await go(page, path);
    await ready();
    if (prepare) await prepare();
    await settle(page);
    await save(page, `desktop-${key}`, FEATURE_WIDTH, { clip: MAIN });
  };

  // The hero already shows the top of Home; here, scroll the feed to the first photo post.
  await shoot('home', '/home', () => page.getByText('Family feed').waitFor(), async () => {
    const photo = page.locator('main article img[src*="/uploads/"]').first();
    await photo.waitFor({ timeout: 10_000 }).catch(() => {});
    if (await photo.count()) {
      await photo.evaluate((img) => img.closest('article').scrollIntoView({ block: 'start' }));
      await page.evaluate(() => window.scrollBy(0, -80)); // just below the sticky top bar
    }
  });
  await shoot('calendar', '/calendar?view=month', () => page.getByRole('button', { name: 'Today' }).first().waitFor());
  await shoot('lists', `/lists/${groceries.id}`, () => page.getByText(groceries.name).first().waitFor());
  await shoot('messages', `/messages/${family.id}`, () => page.getByRole('textbox').last().waitFor(), () => trimChat(page));
  await shoot('photos', `/photos/albums/${album.id}`, () => page.getByText(album.title).first().waitFor());
  await shoot('meals', `/meals/recipes/${recipe.id}`, () => page.getByText(recipe.title).first().waitFor());
  await shoot('vault', '/vault/notes', () => page.getByText('Info cards').first().waitFor(), () => page.waitForTimeout(600));
  await ctx.close();
}

// ---- mobile strip ------------------------------------------------------------------------------
for (const [key, theme, path, ready, prepare] of [
  ['home', 'light', '/home', (p) => p.getByText('Family feed').waitFor()],
  ['calendar', 'light', '/calendar?view=agenda', (p) => p.getByRole('button', { name: 'Today' }).first().waitFor()],
  ['lists', 'light', `/lists/${groceries.id}`, (p) => p.getByText(groceries.name).first().waitFor()],
  ['messages', 'dark', `/messages/${family.id}`, (p) => p.getByRole('textbox').last().waitFor(), trimChat],
  ['budget', 'light', '/budget', (p) => p.getByText('Where the money went').waitFor()],
  ['photos', 'dark', `/photos/albums/${album.id}`, (p) => p.getByText(album.title).first().waitFor()],
]) {
  if (!want(`mobile-${key}`) && !want('mobile')) continue;
  const { ctx, page } = await open({ viewport: PHONE, theme });
  await go(page, path);
  await ready(page);
  if (prepare) await prepare(page);
  await settle(page, 1500);
  await save(page, `mobile-${key}${theme === 'dark' ? '-dark' : ''}`, 780, { theme, radius: 44, line: 3 });
  await ctx.close();
}

// ---- bank statement import (review step), then insights with the imported data -----------------
if (want('import') || want('insights')) {
  // Taller window so the review list shows several rows.
  const { ctx, page } = await open({ viewport: { width: 1280, height: 1000 } });
  await go(page, '/budget/import');
  await page.getByText('Drop a bank statement here').waitFor();
  const csv = readFileSync(new URL('../server/test/fixtures/statements/dbs.csv', import.meta.url));
  await page.locator('input[type=file]').setInputFiles({ name: 'dbs.csv', mimeType: 'text/csv', buffer: csv });
  await page.getByText('Step 2 of 4').waitFor({ timeout: 30_000 });
  await page.addStyleTag({ content: CALM_CSS });
  // The demo family budgets in USD while the sample statement is SGD; hide that one-off notice, and
  // the floating "Continue" bar that would cover the last rows.
  await hideByText(page, 'This statement is in SGD');
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('main *')].filter((el) => /transactions selected$/.test(el.textContent.trim())).at(-1);
    for (let el = label; el && el !== document.body; el = el.parentElement) {
      if (['fixed', 'sticky'].includes(getComputedStyle(el).position)) { el.style.visibility = 'hidden'; break; }
    }
  });
  await settle(page);
  // End the crop just above the first day heading whose row would be cut off by the window.
  const end = await page.evaluate(() => {
    const days = [...document.querySelectorAll('main *')]
      .filter((el) => el.children.length === 0 && /^(MON|TUE|WED|THU|FRI|SAT|SUN), [A-Z]{3} \d+$/i.test(el.textContent.trim()))
      .map((el) => el.getBoundingClientRect().top);
    const cut = days.find((top) => top > window.innerHeight - 110);
    return Math.floor((cut ?? window.innerHeight) - 10);
  });
  if (want('import')) await save(page, 'desktop-import', FEATURE_WIDTH, { clip: { ...MAIN, height: end - MAIN.y } });
  // Finish the import so Insights has balances to show.
  await page.evaluate(() => document.querySelectorAll('[style*="visibility: hidden"]').forEach((el) => (el.style.visibility = '')));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText(/Step [34] of 4/).waitFor();
  if (await page.getByText('Step 3 of 4').count()) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Step 4 of 4').waitFor();
  }
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('link', { name: 'See transactions' }).waitFor({ timeout: 30_000 });
  await ctx.close();

  if (want('insights')) {
    const { ctx: c2, page: p2 } = await open({ viewport: DESKTOP });
    await go(p2, '/budget/insights');
    await p2.getByText('Can we afford our goals?').waitFor();
    await settle(p2, 1500);
    await save(p2, 'desktop-insights', FEATURE_WIDTH, { clip: MAIN });
    await c2.close();
  }
}

await browser.close();
console.log(`\nSaved ${saved.length} screenshots to ${OUT}`);
if (errors.length) {
  console.error(`\n${errors.length} browser error(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
