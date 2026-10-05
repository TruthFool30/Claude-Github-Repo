// Playwright smoke test for the photos module.
//   BASE=http://localhost:4205 SHOTS=/tmp/shots node scripts/e2e-photos.mjs
// Needs a freshly seeded instance (npm run seed) with HEARTH_RATE_LIMITS=off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { encodePng } from '../server/src/modules/photos/png.js';
import { renderScene, PRESETS } from '../server/src/modules/photos/scenes.js';

// Run Node and the browser in the demo family's time zone (seed.js DEMO_TZ), so "today" matches the server.
process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';

const BASE = process.env.BASE || 'http://localhost:4205';
const SHOTS = process.env.SHOTS || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e-shots', 'photos');
fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'photos-e2e-'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let failPage = null;
let step = '';
const log = (s) => {
  step = s;
  console.log(`• ${s}`);
};

async function context({ email = 'alex@hearth.test', mobile = false, theme = 'light' } = {}) {
  const ctx = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } },
  );
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource.*40[0134]/.test(m.text()) && errors.push(`[${email} ${step}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${email} ${step}] pageerror ${e.message}`));
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert.equal(res.status(), 200, 'login');
  return { ctx, page };
}

const noOverflow = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `${label}: horizontal overflow ${over}px`);
};

// Test images
const files = ['sunsetBeach', 'alpine', 'party'].map((preset, i) => {
  const [k, p] = PRESETS[preset];
  const f = path.join(TMP, `e2e-${i + 1}.png`);
  fs.writeFileSync(f, encodePng(600, 400, renderScene(k, p, 600, 400, 99 + i)));
  return f;
});

try {
  const A = await context();
  const B = await context({ email: 'sam@hearth.test' });
  const a = A.page;
  failPage = a;
  const b = B.page;

  log('albums overview shows seeded albums');
  await a.goto(`${BASE}/photos`);
  await a.getByRole('heading', { name: 'Recently added' }).waitFor();
  const cards = a.locator('a[href^="/photos/albums/"]');
  assert.ok((await cards.count()) >= 4, 'seeded albums');
  await a.getByText('Beach Trip — Outer Banks').first().waitFor();

  log('second user watches the albums list');
  await b.goto(`${BASE}/photos`);
  await b.getByRole('heading', { name: 'Albums' }).waitFor();

  log('create an album');
  await a.getByRole('button', { name: 'New album' }).first().click();
  await a.getByRole('dialog').getByLabel('Album name').fill('E2E Picnic');
  await a.getByRole('dialog').getByLabel('Description').fill('Sandwiches in the park');
  await a.getByRole('button', { name: 'Create album' }).click();
  await a.waitForURL(/\/photos\/albums\/\d+/);
  const albumId = Number(a.url().match(/albums\/(\d+)/)[1]);
  await a.getByRole('heading', { name: 'E2E Picnic' }).waitFor();
  await a.getByText('Add the first photos').waitFor();

  log('live: B sees the new album without reload');
  await b.getByText('E2E Picnic').first().waitFor({ timeout: 8000 });

  log('B opens the album');
  await b.goto(`${BASE}/photos/albums/${albumId}`);
  await b.getByText('Add the first photos').waitFor();

  log('upload 3 photos with progress');
  await a.locator('[data-testid="photo-file-input"]').setInputFiles(files);
  await a.getByRole('region', { name: 'Photo uploads' }).waitFor();
  await a.getByText('3 photos added to E2E Picnic').waitFor({ timeout: 20000 });
  await a.locator('[data-photo-id]').nth(2).waitFor();
  assert.equal(await a.locator('[data-photo-id]').count(), 3);

  log('live: B sees the 3 photos');
  await b.locator('[data-photo-id]').nth(2).waitFor({ timeout: 8000 });

  log('wall activity entry was logged once');
  const act = await (await a.request.get(`${BASE}/api/activity?module=photos`)).json();
  assert.ok(act.some((e) => e.summary === 'added 3 photos to E2E Picnic'), 'batched activity');
  const notes = await (await b.request.get(`${BASE}/api/notifications`)).json();
  assert.ok(notes.items.some((n) => n.title === 'New photos in E2E Picnic'), 'family notified');

  log('security: disguised HTML is rejected with a per-file error, non-images are skipped');
  const evil = path.join(TMP, 'evil.png');
  fs.writeFileSync(evil, '<!doctype html><html><body><script>alert(1)</script></body></html>');
  const notesFile = path.join(TMP, 'notes.txt');
  fs.writeFileSync(notesFile, 'just text');
  const truncated = path.join(TMP, 'truncated.png');
  fs.writeFileSync(truncated, fs.readFileSync(files[0]).subarray(0, 4000)); // valid header, cut off mid-image
  await a.locator('[data-testid="photo-file-input"]').setInputFiles([evil, notesFile, truncated]);
  await a.getByText("Skipped 1 file that isn't a photo").waitFor();
  const tray = a.getByRole('region', { name: 'Photo uploads' });
  await tray.getByText('“evil.png” is not a supported image').waitFor({ timeout: 15000 });
  await tray.getByText('“truncated.png” looks damaged').waitFor({ timeout: 15000 });
  assert.equal(await tray.getByRole('button', { name: /^Retry/ }).count(), 0, 'no Retry for validation errors');
  assert.equal(await tray.locator('li', { hasText: 'evil.png' }).locator('img').count(), 0, 'rejected files show an icon, not a broken preview');
  await a.screenshot({ path: path.join(SHOTS, '11-upload-errors-d1280-light.png') });
  await tray.getByRole('button', { name: 'Dismiss evil.png' }).click();
  await tray.getByRole('button', { name: 'Dismiss truncated.png' }).click();
  assert.equal(await a.locator('[data-photo-id]').count(), 3, 'nothing extra stored');
  const up = await a.request.post(`${BASE}/api/photos/upload`, {
    multipart: { file: { name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') } },
  });
  assert.equal(up.status(), 400, 'SVG disguised as JPEG rejected');

  log('open viewer, like and comment');
  await a.locator('[data-photo-id]').first().click();
  const viewer = a.getByRole('dialog', { name: /Photo 1 of 3/ });
  await viewer.waitFor();
  const photoId = Number(new URL(a.url()).searchParams.get('photo'));
  assert.ok(photoId > 0, 'deep link param');
  await a.getByRole('button', { name: 'Like photo' }).click();
  await a.getByRole('button', { name: 'Unlike photo' }).waitFor();
  // back-to-back key presses (no waits) must land exactly: → ← → → ← = photo 2
  for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft']) await a.keyboard.press(k);
  await a.getByRole('dialog', { name: /Photo 2 of 3/ }).waitFor();
  await a.waitForTimeout(400);
  await a.getByRole('dialog', { name: /Photo 2 of 3/ }).waitFor({ timeout: 100 });
  await a.keyboard.press('ArrowRight');
  await a.keyboard.press('ArrowLeft');
  await a.keyboard.press('ArrowLeft');
  await a.getByRole('dialog', { name: /Photo 1 of 3/ }).waitFor();
  assert.equal(Number(new URL(a.url()).searchParams.get('photo')), photoId, 'URL follows the rapid navigation');

  log('B opens the same photo by deep link');
  await b.goto(`${BASE}/photos/albums/${albumId}?photo=${photoId}`);
  await b.getByRole('dialog', { name: /Photo 1 of 3/ }).waitFor();
  await b.getByText('Alex likes this').waitFor();

  await a.getByLabel('Write a comment').fill('What a day @Sam!');
  await a.keyboard.press('Enter');
  await a.locator('li', { hasText: 'What a day' }).first().waitFor();

  log('live: B sees the comment appear');
  await b.getByRole('dialog', { name: /Photo 1/ }).getByText('What a day').first().waitFor({ timeout: 8000 });
  await b.waitForTimeout(1200);
  assert.equal(await b.getByRole('status').getByText('What a day @Sam!').count(), 0, 'no toast for the photo Sam is viewing');
  const samNotes = await (await b.request.get(`${BASE}/api/notifications`)).json();
  assert.ok(samNotes.items.some((n) => n.title.includes('mentioned you') && n.read_at), 'mention kept in the bell, marked read');

  log('edit caption');
  await a.getByRole('button', { name: 'Add a caption' }).click();
  await a.getByLabel('Caption').fill('Picnic blanket spread');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await a.getByText('Picnic blanket spread').first().waitFor();
  await b.getByRole('dialog', { name: /Photo 1/ }).getByText('Picnic blanket spread').first().waitFor({ timeout: 8000 });

  log('set as cover via menu');
  await a.getByRole('dialog', { name: /Photo 1 of 3/ }).getByRole('button', { name: 'Photo actions' }).click();
  await a.getByRole('menuitem', { name: 'Set as album cover' }).click();
  await a.getByText('Album cover updated').waitFor();
  await a.keyboard.press('Escape');
  await a.getByRole('dialog', { name: /Photo/ }).waitFor({ state: 'detached' });
  assert.equal(new URL(a.url()).searchParams.get('photo'), null, 'closing clears ?photo');

  log('select and move one photo out');
  await a.getByRole('button', { name: 'Select', exact: true }).click();
  await a.locator('[data-photo-id]').nth(2).click();
  await a.getByRole('toolbar', { name: 'Selected photos' }).getByText('1 selected').waitFor();
  await a.getByRole('toolbar', { name: 'Selected photos' }).getByRole('button', { name: 'Move' }).click();
  await a.getByRole('radio', { name: /Autumn Hike/ }).click();
  await a.getByRole('button', { name: 'Move', exact: true }).last().click();
  await a.getByText('1 photo moved to Autumn Hike at Blue Ridge').waitFor();
  await a.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 2);
  await b.keyboard.press('Escape');
  await b.waitForFunction(() => document.querySelectorAll('[data-photo-id]').length === 2, null, { timeout: 8000 });

  log('all photos timeline with month groups and filters');
  await a.goto(`${BASE}/photos/all`);
  await a.locator('section[aria-label] h2').first().waitFor();
  assert.ok((await a.locator('section[aria-label] h2').count()) >= 3, 'month groups');
  const allTotal = (await (await a.request.get(`${BASE}/api/photos/all?limit=1`)).json()).total;
  await a.locator('[data-photo-id]').first().click();
  await a.getByRole('dialog', { name: new RegExp(`^Photo 1 of ${allTotal}`) }).waitFor();
  assert.equal(await a.getByRole('button', { name: 'Previous photo' }).count(), 0, 'no wrap-around at the start');
  await a.keyboard.press('ArrowLeft');
  await a.getByRole('dialog', { name: new RegExp(`^Photo 1 of ${allTotal}`) }).waitFor();
  for (let i = 0; i < 4; i++) await a.keyboard.press('ArrowRight');
  await a.getByRole('dialog', { name: new RegExp(`^Photo 5 of ${allTotal}`) }).waitFor();
  await a.keyboard.press('ArrowLeft');
  await a.keyboard.press('ArrowLeft');
  await a.getByRole('dialog', { name: new RegExp(`^Photo 3 of ${allTotal}`) }).waitFor();
  await a.waitForTimeout(400);
  await a.getByRole('dialog', { name: new RegExp(`^Photo 3 of ${allTotal}`) }).waitFor({ timeout: 100 });
  await a.keyboard.press('Escape');
  await a.getByRole('dialog', { name: /Photo/ }).waitFor({ state: 'detached' });
  await a.getByRole('button', { name: /Mia/ }).first().click();
  await a.waitForURL(/member=/);
  await a.locator('[data-photo-id]').first().waitFor();
  await noOverflow(a, 'timeline');

  log('delete the album (keep photos)');
  await a.goto(`${BASE}/photos/albums/${albumId}`);
  await a.getByRole('button', { name: 'Album actions' }).click();
  await a.getByRole('menuitem', { name: 'Delete album' }).click();
  await a.getByRole('dialog').getByText('Keep the photos').waitFor();
  assert.ok(await a.getByRole('dialog').getByRole('radio', { name: /Keep the photos/ }).isChecked(), 'keep is the default');
  await a.getByRole('dialog').getByRole('button', { name: 'Delete album' }).click();
  await a.waitForURL(`${BASE}/photos`);
  await b.getByText('Album not found').waitFor({ timeout: 8000 });

  log('child cannot delete others\' photos (UI hides the action)');
  const K = await context({ email: 'leo@hearth.test' });
  const albums = await (await K.page.request.get(`${BASE}/api/photos/albums`)).json();
  const beach = albums.find((x) => x.title.startsWith('Beach'));
  const det = await (await K.page.request.get(`${BASE}/api/photos/albums/${beach.id}`)).json();
  const foreign = det.photos.find((p) => p.uploaded_by !== det.photos.find((q) => q.can_delete)?.uploaded_by && !p.can_delete);
  await K.page.goto(`${BASE}/photos/albums/${beach.id}?photo=${foreign.id}`);
  await K.page.getByRole('dialog', { name: /Photo/ }).getByRole('button', { name: 'Photo actions' }).click();
  await K.page.getByRole('menuitem', { name: 'Download' }).waitFor();
  assert.equal(await K.page.getByRole('menuitem', { name: 'Delete photo' }).count(), 0);
  await K.ctx.close();

  await A.ctx.close();
  await B.ctx.close();

  // ---- screenshots ------------------------------------------------------------------------------------
  const hike = albums.find((x) => x.title.includes('Hike'));
  const hikeDet = await (await (await context()).page.request.get(`${BASE}/api/photos/albums/${hike.id}`)).json();
  const commented = hikeDet.photos.find((p) => p.comment_count > 0);
  for (const mobile of [false, true]) {
    for (const theme of ['light', 'dark']) {
      const tag = `${mobile ? 'm390' : 'd1280'}-${theme}`;
      const { ctx, page } = await context({ mobile, theme });
      const shot = async (name) => {
        await page.waitForTimeout(450);
        await page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
      };
      step = `shots ${tag}`;
      await page.goto(`${BASE}/photos`);
      await page.getByRole('heading', { name: 'Albums' }).waitFor();
      await page.waitForFunction(() => [...document.images].filter((i) => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
      await noOverflow(page, `albums ${tag}`);
      await shot('01-albums');
      await page.goto(`${BASE}/photos/all`);
      await page.locator('[data-photo-id]').first().waitFor();
      await page.waitForFunction(() => [...document.images].filter((i) => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
      await noOverflow(page, `all ${tag}`);
      await shot('02-all-photos');
      await page.goto(`${BASE}/photos/albums/${hike.id}`);
      await page.locator('[data-photo-id]').first().waitFor();
      await page.waitForFunction(() => [...document.images].filter((i) => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
      await noOverflow(page, `album ${tag}`);
      await shot('03-album');
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      await page.locator('[data-photo-id]').nth(1).click();
      await page.locator('[data-photo-id]').nth(3).click();
      await shot('04-select');
      await page.getByRole('toolbar', { name: 'Selected photos' }).getByRole('button', { name: 'Move' }).click();
      await page.getByRole('dialog').waitFor();
      await shot('05-move-dialog');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Cancel selection' }).click();
      await page.goto(`${BASE}/photos/albums/${hike.id}?photo=${commented.id}`);
      await page.getByRole('dialog', { name: /Photo/ }).waitFor();
      await page.waitForFunction(() => [...document.images].filter((i) => i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(400);
      await shot('06-viewer');
      if (mobile) {
        await page.getByRole('button', { name: 'Photo details' }).click();
        await page.getByRole('region', { name: 'Photo details' }).locator('li').first().waitFor();
        await shot('07-viewer-details');
      }
      await page.goto(`${BASE}/photos`);
      await page.getByRole('heading', { name: 'Albums' }).waitFor();
      await page.getByRole('button', { name: 'New album' }).first().click();
      await page.getByRole('dialog').waitFor();
      await shot('08-new-album');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: mobile ? 'Upload photos' : 'Upload' }).first().click();
      await page.getByRole('dialog').waitFor();
      await shot('09-upload-target');
      await page.keyboard.press('Escape');
      await page.goto(`${BASE}/photos/albums/${hike.id}`);
      await page.getByRole('button', { name: 'Album actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete album' }).click();
      await page.getByRole('dialog').waitFor();
      await shot('10-delete-album');
      await ctx.close();
    }
  }
  console.log(`\nScreenshots in ${SHOTS}`);
  if (errors.length) {
    console.error('Console errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('✓ photos e2e passed (no console errors)');
  }
} catch (err) {
  console.error(`✗ failed at step "${step}":`, err);
  await failPage?.screenshot({ path: path.join(SHOTS, 'FAILURE.png') }).catch(() => {});
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
