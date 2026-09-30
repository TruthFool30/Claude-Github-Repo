// Locator browser smoke test + screenshots.
//   BASE=http://localhost:4208 SHOTS=/tmp/shots node scripts/e2e-locator.mjs
// Needs a freshly seeded instance (npm run seed). Exits non-zero on the first failed assertion.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(path.join(root, 'node_modules/playwright/index.mjs'));

const BASE = process.env.BASE || 'http://localhost:4208';
const SHOTS = process.env.SHOTS || path.join(root, 'e2e-shots', 'locator');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const consoleErrors = [];
let step = '';
const ok = (cond, msg) => {
  if (!cond) throw new Error(`[${step}] assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

// Where the new test place goes (between Home and the school, outside other places).
const SPOT = { latitude: 30.2952, longitude: -97.7621 };

// Stand-in map tiles (the sandbox can't reach OSM) so the real tile path is exercised too.
const TILE = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#EEEAE2"/><rect x="150" y="30" width="80" height="70" rx="6" fill="#D3E7C8"/><path d="M0 128H256M90 0V256" stroke="#fff" stroke-width="10"/><path d="M0 206L256 176" stroke="#F4E1A6" stroke-width="6"/></svg>';

async function context({ email, width = 1280, height = 800, theme = 'light', mobile = false, geo = true, tiles = false }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    ...(geo ? { geolocation: SPOT, permissions: ['geolocation'] } : {}),
  });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  if (tiles) await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: TILE }));
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/tile\.openstreetmap|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_CONNECTION|ERR_PROXY|ERR_INTERNET_DISCONNECTED/.test(url + m.text())) return; // offline tiles are expected here
    consoleErrors.push(`${email} ${theme} ${width}: ${m.text()} ${url}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${email}: pageerror ${e.message}`));
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  if (!res.ok()) throw new Error(`login failed for ${email}: ${res.status()}`);
  return { ctx, page };
}

const shot = async (page, name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const noOverflow = async (page, what) => {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok(sw <= iw + 1, `no horizontal overflow on ${what} (${sw} <= ${iw})`);
};
const waitMap = async (page) => {
  await page.waitForSelector('.loc-map .loc-pin', { timeout: 15000 });
  // Tiles either load or the offline notice appears (≤ 8s).
  await page.waitForFunction(() => document.querySelector('.leaflet-tile-loaded') || document.querySelector('.loc-map--grid'), null, { timeout: 12000 });
  await page.waitForTimeout(900); // fly-to animation
};

try {
  // ---------------------------------------------------------------------------------------------
  step = 'overview';
  const A = await context({ email: 'alex@hearth.test' });
  const B = await context({ email: 'sam@hearth.test', geo: false });
  const a = A.page;
  const b = B.page;
  await a.goto(`${BASE}/locator`);
  await waitMap(a);
  ok((await a.locator('[data-testid^="member-"]').count()) === 4, 'four members listed');
  ok((await a.locator('.loc-map .loc-pin').count()) === 4, 'four member pins on the map');
  ok((await a.locator('.loc-place').count()) >= 8, 'saved places drawn on the map');
  const tilesFailed = await a.locator('[data-testid="tiles-notice"]').isVisible();
  console.log(`  · map tiles ${tilesFailed ? 'unavailable → offline grid + notice shown' : 'loaded'}`);
  if (tilesFailed) ok(await a.locator('.loc-map--grid').isVisible(), 'offline grid styling applied');
  ok((await a.locator('[data-testid^="member-"]', { hasText: 'At ' }).count()) >= 1, 'someone shown at a saved place');
  ok((await a.locator('[data-testid="recent-events"] li').count()) > 0, 'recent arrivals listed');
  await shot(a, 'desktop-light-people');

  await b.goto(`${BASE}/locator/places`);
  await waitMap(b);

  // ---------------------------------------------------------------------------------------------
  step = 'member detail';
  await a.locator('[data-testid^="member-"]', { hasText: 'Mia' }).click();
  await a.waitForURL(/\/locator\/member\/\d+/);
  await a.waitForSelector('[data-testid="timeline"] li');
  ok(await a.getByRole('heading', { name: 'Mia Rivera' }).isVisible(), 'member detail header');
  ok(await a.getByText('Battery N/A').isVisible(), 'battery N/A shown');
  const todayStops = await a.locator('[data-testid="timeline"] li').count();
  ok(todayStops >= 1, `today's timeline has ${todayStops} stop(s)`);
  await shot(a, 'desktop-light-member');
  await a.getByRole('tab', { name: /Yesterday/ }).click();
  await a.waitForTimeout(700);
  ok((await a.locator('[data-testid="timeline"] li').count()) >= 2, 'yesterday timeline has stops');
  ok((await a.locator('.leaflet-overlay-pane path').count()) > 8, 'history path drawn');
  await shot(a, 'desktop-light-member-yesterday');

  // ---------------------------------------------------------------------------------------------
  step = 'places';
  await a.goto(`${BASE}/locator/places`);
  await a.waitForSelector('[data-testid="places-list"] li');
  ok((await a.locator('[data-testid="places-list"] > li').count()) >= 8, 'places list shows seeded places');
  await shot(a, 'desktop-light-places');
  await a.locator('[data-testid="places-list"] a', { hasText: 'Zilker soccer fields' }).click();
  await a.waitForSelector('[data-testid="place-detail"]');
  ok(await a.getByText('Here now').isVisible(), 'place detail shows who is here');
  await a.waitForTimeout(600);
  await shot(a, 'desktop-light-place');

  // ---------------------------------------------------------------------------------------------
  step = 'add place';
  await a.getByRole('button', { name: 'Add place' }).first().click();
  const dialog = a.getByRole('dialog');
  await dialog.waitFor();
  await a.waitForTimeout(600);
  await dialog.getByRole('button', { name: 'Use my location' }).click();
  await a.waitForFunction(() => !document.querySelector('[data-testid="place-coords"]')?.textContent?.includes('No spot'));
  await dialog.getByRole('radio', { name: 'Park' }).click();
  await dialog.getByLabel('Name').fill('Pease Park playground');
  await dialog.getByRole('button', { name: '250 m' }).click();
  await dialog.getByLabel('Address or note').fill('Kingsbury St');
  await a.waitForTimeout(500);
  await shot(a, 'desktop-light-add-place');
  await dialog.getByRole('button', { name: 'Add place' }).click();
  await a.waitForURL(/\/locator\/places\/\d+/);
  await a.getByRole('heading', { name: 'Pease Park playground' }).waitFor({ timeout: 8000 });
  ok(true, 'new place created and opened');
  await b.waitForSelector('[data-testid="places-list"] a:has-text("Pease Park playground")', { timeout: 8000 });
  ok(true, 'second browser sees the new place live');

  // validation: empty name
  await a.getByRole('button', { name: 'Add place' }).first().click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Add place' }).click();
  ok(await dialog.getByRole('alert').isVisible(), 'empty place form shows an error');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });

  // ---------------------------------------------------------------------------------------------
  step = 'check in';
  await a.goto(`${BASE}/locator`);
  await waitMap(a);
  await b.goto(`${BASE}/locator`);
  await waitMap(b);
  await a.getByRole('button', { name: 'Check in' }).first().click();
  await dialog.waitFor();
  await a.waitForSelector('[data-testid="checkin-summary"]');
  ok((await a.locator('[data-testid="checkin-summary"]').innerText()).includes('Pease Park playground'), 'check-in dialog recognizes the place');
  await dialog.getByLabel('Add a note').fill('Picnic with the kids 🧺');
  await a.waitForTimeout(400);
  await shot(a, 'desktop-light-checkin');
  await dialog.getByRole('button', { name: 'Check in' }).click();
  await dialog.waitFor({ state: 'detached' });
  await a.waitForSelector('[data-testid^="member-"]:has-text("At Pease Park playground")');
  ok(true, 'own row shows the new place');
  await b.waitForSelector('[data-testid^="member-"]:has-text("At Pease Park playground")', { timeout: 8000 });
  ok(true, 'second browser sees the check-in live');
  const bell = await (await B.page.request.get(`${BASE}/api/notifications`)).json();
  ok(bell.items.some((n) => /^Alex (left .+ and )?arrived at Pease Park playground$/.test(n.title)), 'Sam was notified about the arrival');
  const samActs = async () => (await (await B.page.request.get(`${BASE}/api/activity?module=locator&limit=100`)).json()).filter((x) => x.user?.name === 'Alex Rivera' && ['checked_in', 'arrived'].includes(x.verb));
  ok((await samActs()).length > 0, 'Alex’s check-in is on the Wall for Sam');

  // ---------------------------------------------------------------------------------------------
  step = 'privacy';
  await a.getByRole('switch', { name: 'Share my location' }).click();
  await a.getByText('Paused — nobody can see where you are').waitFor();
  await b.waitForSelector('[data-testid^="member-"]:has-text("Location paused")', { timeout: 8000 });
  ok(true, 'pausing hides Alex from Sam live');
  ok((await b.locator('.loc-map .loc-pin').count()) === 3, 'Alex pin removed from Sam’s map');
  ok((await samActs()).length === 0, 'pausing removed Alex’s check-ins/arrivals from Sam’s Wall feed');
  const bell2 = await (await B.page.request.get(`${BASE}/api/notifications`)).json();
  ok(!bell2.items.some((n) => n.title.startsWith('Alex ') && n.module === 'locator'), 'pausing removed Alex’s arrival notifications for Sam');
  ok(await a.getByText('Hidden from family').isVisible(), 'own row says hidden from family');
  await shot(b, 'desktop-light-paused-other');
  await a.getByRole('switch', { name: 'Share my location' }).click();
  await b.waitForSelector('[data-testid^="member-"]:has-text("At Pease Park playground")', { timeout: 8000 });
  ok(true, 'resuming shows Alex again');

  // ---------------------------------------------------------------------------------------------
  step = 'live sharing denied';
  // Simulate the user blocking location for the site.
  await b.evaluate(() => {
    const deny = (_ok, err) => { setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' }), 50); return 1; };
    navigator.geolocation.watchPosition = deny;
    navigator.geolocation.getCurrentPosition = deny;
  });
  await b.getByRole('button', { name: 'Share live' }).click();
  await b.getByText(/Location permission is blocked|location isn’t available|took too long/).waitFor({ timeout: 10000 });
  ok((await b.getByText('Sharing your live location').count()) === 0, 'no “sharing live” toast when permission is denied');

  step = 'live sharing';
  await a.getByRole('button', { name: 'Share live' }).click();
  await a.getByText(/sent just now|sent \d+ min ago/).waitFor({ timeout: 10000 });
  await a.getByText('Sharing your live location').first().waitFor({ timeout: 5000 });
  ok(await a.getByRole('button', { name: 'Live sharing on' }).isVisible(), 'live sharing active and sending');
  await a.getByRole('button', { name: 'Live sharing on' }).click();
  ok(await a.getByRole('button', { name: 'Share live' }).isVisible(), 'live sharing stopped');

  // ---------------------------------------------------------------------------------------------
  step = 'map click';
  const box = await a.locator('.loc-map').boundingBox();
  await a.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.75);
  await a.waitForSelector('[data-testid="map-popup"]');
  await a.waitForTimeout(300);
  await shot(a, 'desktop-light-map-popup');
  await a.locator('[data-testid="map-popup"]').getByRole('button', { name: 'Add a place here' }).click();
  await dialog.waitFor();
  ok(!(await a.locator('[data-testid="place-coords"]').innerText()).includes('No spot'), 'dialog prefilled with clicked point');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });

  // ---------------------------------------------------------------------------------------------
  step = 'list view';
  await a.getByRole('radio', { name: 'List' }).click();
  await a.waitForSelector('[data-testid="board"]');
  ok((await a.locator('[data-testid="board"] [data-testid^="member-"]').count()) === 4, 'board lists everyone');
  await shot(a, 'desktop-light-list');
  await a.getByRole('radio', { name: 'Map' }).click();

  // ---------------------------------------------------------------------------------------------
  step = 'edit + delete place';
  await a.goto(`${BASE}/locator/places`);
  await a.waitForSelector('[data-testid="places-list"] li');
  await a.getByRole('button', { name: 'Actions for Pease Park playground' }).click();
  await a.getByRole('menuitem', { name: 'Edit place' }).click();
  await dialog.waitFor();
  await dialog.getByLabel('Name').fill('Pease Park');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await dialog.waitFor({ state: 'detached' });
  await a.waitForSelector('[data-testid="places-list"] a:has-text("Pease Park")');
  await b.goto(`${BASE}/locator/places`);
  await b.waitForSelector('[data-testid="places-list"] a:has-text("Pease Park")');
  await a.getByRole('button', { name: 'Actions for Pease Park' }).click();
  await a.getByRole('menuitem', { name: 'Delete place' }).click();
  await shot(a, 'desktop-light-delete-confirm');
  await a.getByRole('dialog').getByRole('button', { name: 'Delete place' }).click();
  await b.waitForFunction(() => ![...document.querySelectorAll('[data-testid="places-list"] a')].some((x) => x.textContent.includes('Pease Park')), null, { timeout: 8000 });
  ok(true, 'deletion reaches the second browser live');

  // ---------------------------------------------------------------------------------------------
  step = 'child permissions';
  const C = await context({ email: 'leo@hearth.test', geo: false });
  await C.page.goto(`${BASE}/locator/places`);
  await C.page.waitForSelector('[data-testid="places-list"] li');
  ok((await C.page.getByRole('button', { name: /^Actions for / }).count()) === 0, 'child cannot edit places added by grown-ups');
  await C.ctx.close();

  await A.ctx.close();
  await B.ctx.close();

  // ---------------------------------------------------------------------------------------------
  step = 'screenshots';
  for (const theme of ['light', 'dark']) {
    for (const size of [{ w: 1280, h: 800, mobile: false, tag: 'desktop' }, { w: 390, h: 844, mobile: true, tag: 'mobile' }]) {
      // Offline look first, then everything with (stand-in) map tiles.
      {
        const off = await context({ email: 'alex@hearth.test', width: size.w, height: size.h, theme, mobile: size.mobile });
        await off.page.goto(`${BASE}/locator`);
        await waitMap(off.page);
        await shot(off.page, `${size.tag}-${theme}-offline`);
        await off.ctx.close();
      }
      const { ctx, page } = await context({ email: 'alex@hearth.test', width: size.w, height: size.h, theme, mobile: size.mobile, tiles: true });
      const p = `${size.tag}-${theme}`;
      await page.goto(`${BASE}/locator`);
      await waitMap(page);
      ok((await page.locator('.leaflet-tile-loaded').count()) > 0, `${p}: map tiles render`);
      await noOverflow(page, `${p} people`);
      await shot(page, `${p}-people`);
      if (size.mobile) {
        await page.screenshot({ path: path.join(SHOTS, `${p}-people-full.png`), fullPage: true });
      }
      const mia = await page.locator('[data-testid^="member-"]', { hasText: 'Mia' }).getAttribute('href');
      await page.goto(`${BASE}${mia}`);
      await page.waitForSelector('[data-testid="timeline"] li');
      await page.waitForTimeout(900);
      await noOverflow(page, `${p} member`);
      await shot(page, `${p}-member`);
      if (size.mobile) await page.screenshot({ path: path.join(SHOTS, `${p}-member-full.png`), fullPage: true });
      await page.goto(`${BASE}/locator/places`);
      await page.waitForSelector('[data-testid="places-list"] li');
      await page.waitForTimeout(700);
      await shot(page, `${p}-places`);
      if (size.mobile) await page.screenshot({ path: path.join(SHOTS, `${p}-places-full.png`), fullPage: true });
      await page.locator('[data-testid="places-list"] a', { hasText: 'Maple Grove' }).click();
      await page.waitForSelector('[data-testid="place-detail"]');
      await page.waitForTimeout(900);
      await noOverflow(page, `${p} place`);
      await shot(page, `${p}-place`);
      await page.getByRole('button', { name: 'Edit' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(700);
      await shot(page, `${p}-edit-place`);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.goto(`${BASE}/locator`);
      await waitMap(page);
      await page.getByRole('button', { name: 'Check in' }).first().click();
      await page.waitForSelector('[data-testid="checkin-summary"]');
      await shot(page, `${p}-checkin`);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.getByRole('radio', { name: 'List' }).click();
      await page.waitForSelector('[data-testid="board"]');
      await noOverflow(page, `${p} list`);
      await shot(page, `${p}-list`);
      await ctx.close();
    }
  }

  ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `:\n${consoleErrors.join('\n')}` : ''}`);
  console.log(`\nLocator e2e passed. Screenshots in ${SHOTS}`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (consoleErrors.length) console.error(`Console errors:\n${consoleErrors.join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
