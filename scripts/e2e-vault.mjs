// Playwright smoke test + screenshots for the Contacts & Docs (vault) module.
//   BASE=http://localhost:4209 SHOTS=/tmp/vault-shots node scripts/e2e-vault.mjs
// Needs a freshly seeded instance (npm run seed) with HEARTH_RATE_LIMITS=off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4209';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'vault-shots');
const NO_SHOTS = process.env.NO_SHOTS === '1';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

async function session(email, { width = 1280, height = 800, mobile = false, theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] pageerror ${e.message}`));
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  if (!res.ok()) throw new Error(`login failed for ${email}: ${res.status()}`);
  return { ctx, page };
}
const visible = (loc) => loc.locator('visible=true').first();
const shot = async (page, name) => { if (!NO_SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// ------------------------------------------------------------------------------------------
console.log('Functional flows (Alex + Sam in two browsers)');
const alex = await session('alex@hearth.test');
const sam = await session('sam@hearth.test');
const A = alex.page;
const S = sam.page;

await A.goto(`${BASE}/vault`);
await A.waitForURL(/\/vault\/contacts/);
await A.getByRole('heading', { name: 'Emergency' }).waitFor();
ok(await A.getByRole('link', { name: /Emergency services/ }).first().isVisible(), 'emergency section pinned with Emergency services');
ok(await A.getByRole('link', { name: 'Call Emergency services', exact: true }).getAttribute('href') === 'tel:911', 'tap-to-call link for 911');

await A.getByRole('searchbox', { name: 'Search contacts' }).fill('patel');
await A.locator('a[href^="/vault/contacts/"]', { hasText: "Dr. Priya Patel" }).last().click();
await A.getByRole('heading', { name: 'Dr. Priya Patel' }).waitFor();
ok(await A.getByText('Pediatrician').first().isVisible(), 'contact detail shows role');
ok((await A.locator('a[href^="mailto:"]').count()) > 0, 'mailto link present');
await A.getByRole('searchbox', { name: 'Search contacts' }).fill('');

// Category filter chip
await A.getByRole('button', { name: /Home services/ }).click();
ok(await A.locator('a[href^="/vault/contacts/"]', { hasText: "Mike's Plumbing" }).first().isVisible(), 'category chip filters to home services');
await A.getByRole('button', { name: /^All/ }).click();

// Sam watches contacts live
await S.goto(`${BASE}/vault/contacts`);
await S.getByRole('heading', { name: 'Emergency' }).waitFor();

// Create contact
await visible(A.getByRole('button', { name: 'Add contact' })).click();
const dlg = A.getByRole('dialog', { name: 'New contact' });
await dlg.waitFor();
await dlg.locator('input[name=name]').fill('Aunt Carmen');
await dlg.locator('select[name=category]').selectOption('family');
await dlg.getByLabel('Phone number 1').fill('+1 555 0199');
await dlg.getByRole('switch', { name: /Emergency contact/ }).click();
await dlg.getByRole('button', { name: 'Add contact' }).click();
await A.getByRole('heading', { name: 'Aunt Carmen' }).waitFor();
ok(true, 'contact created and opened');
await S.locator('a[href^="/vault/contacts/"]', { hasText: "Aunt Carmen" }).first().waitFor({ timeout: 5000 });
ok(true, "Sam sees the new contact live (no reload)");

// Validation
await visible(A.getByRole('button', { name: 'Add contact' })).click();
await A.getByRole('dialog', { name: 'New contact' }).getByRole('button', { name: 'Add contact' }).click();
ok(await A.getByText('Give this contact a name').isVisible(), 'client validation for empty name');
await A.keyboard.press('Escape');
await settle(A);

// Favorite (optimistic)
await A.getByRole('button', { name: 'Add to favorites' }).click();
await A.getByRole('button', { name: 'Remove from favorites' }).waitFor();
ok(true, 'favorite toggles');

// Delete → gone for Sam
await A.getByRole('button', { name: 'More contact actions' }).click();
await A.getByRole('menuitem', { name: 'Delete contact' }).click();
await A.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
await S.locator('a[href^="/vault/contacts/"]', { hasText: "Aunt Carmen" }).first().waitFor({ state: 'detached', timeout: 5000 });
ok(true, 'deleted contact disappears live for Sam');

// Documents
await A.goto(`${BASE}/vault/docs`);
await A.getByRole('heading', { name: 'Renew soon' }).waitFor();
ok(await A.getByRole('link', { name: /Medical/ }).first().isVisible(), 'folders grid');
ok(await A.getByText('Passport – Alex').first().isVisible(), 'expiring private passport shown to Alex');
await A.getByRole('link', { name: /Medical/ }).first().click();
await A.getByRole('heading', { name: 'Medical' }).waitFor();
await A.getByRole('link', { name: /Immunization record – Mia/ }).click();
const prev = A.getByRole('dialog');
await prev.locator('iframe').waitFor();
ok(true, 'PDF previews inline');
const pdfSrc = await prev.locator('iframe').getAttribute('src');
const pdfRes = await A.request.get(new URL(pdfSrc.split('#')[0], BASE).href);
ok(pdfRes.headers()['content-type'] === 'application/pdf', 'PDF served with application/pdf');
await A.keyboard.press('Escape');
await A.getByRole('link', { name: /Health insurance card/ }).click();
await A.getByRole('dialog').locator('img[alt="Health insurance card"]').waitFor();
ok(await A.getByRole('dialog').locator('img[alt="Health insurance card"]').evaluate((i) => i.complete && i.naturalWidth > 0), 'image preview loads');
await A.keyboard.press('Escape');

// Sam watches the Medical folder
const medicalUrl = A.url();
await S.goto(medicalUrl);
await S.getByRole('heading', { name: 'Medical' }).waitFor();

// Private upload
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-'));
const privFile = path.join(tmp, 'Secret plan.txt');
fs.writeFileSync(privFile, 'top secret surprise party plan');
await A.locator('[data-testid=vault-file-input]').setInputFiles(privFile);
const up = A.getByRole('dialog', { name: 'Upload documents' });
await up.waitFor();
await up.getByRole('radio', { name: 'Only me' }).click();
await up.getByRole('button', { name: 'Upload' }).click();
await up.waitFor({ state: 'detached', timeout: 8000 });
await A.getByRole('link', { name: /Secret plan \(private\)/ }).waitFor();
ok(true, 'private upload appears for Alex with a private marker');
const samDocs = await (await S.request.get(`${BASE}/api/vault/documents`)).json();
ok(!samDocs.some((d) => d.name === 'Secret plan'), 'private upload invisible to Sam (API)');
await settle(S, 800);
ok((await S.getByText('Secret plan').count()) === 0, 'private upload invisible to Sam (UI)');

// Shared upload → Sam sees it live
const sharedFile = path.join(tmp, 'Flu shot receipt.txt');
fs.writeFileSync(sharedFile, 'Flu shots for the whole family - paid');
await A.locator('[data-testid=vault-file-input]').setInputFiles(sharedFile);
await up.waitFor();
await up.getByRole('button', { name: 'Upload' }).click();
await up.waitFor({ state: 'detached', timeout: 8000 });
await S.getByRole('link', { name: /Flu shot receipt/ }).waitFor({ timeout: 5000 });
ok(true, 'shared upload appears live for Sam');

// Rename via menu
await A.getByRole('button', { name: 'Actions for Flu shot receipt' }).click();
await A.getByRole('menuitem', { name: 'Rename or move' }).click();
const edit = A.getByRole('dialog', { name: 'Edit document' });
await edit.getByLabel(/^Name/).fill('Flu shots 2026');
await edit.getByRole('button', { name: 'Save' }).click();
await S.getByRole('link', { name: /Flu shots 2026/ }).waitFor({ timeout: 5000 });
ok(true, 'rename propagates live');

// Text preview
await A.getByRole('link', { name: /Flu shots 2026/ }).click();
await A.getByRole('dialog').getByText('Flu shots for the whole family').waitFor();
ok(true, 'text file previews inline');
// Item: making a shared doc private scrubs the Wall entry + Sam's notification, live.
const samAct = async () => (await (await S.request.get(`${BASE}/api/activity?module=vault`)).json()).map((a) => a.summary).join('|');
const samBell = async () => (await (await S.request.get(`${BASE}/api/notifications`)).json()).items.map((n) => `${n.title} ${n.body}`).join('|');
ok((await samAct()).includes('Flu shot'), 'shared upload is on the Wall for Sam');
ok((await samBell()).includes('Flu shot'), 'Sam was notified about the shared upload');
await A.getByRole('dialog').getByRole('radio', { name: 'Only me' }).click();
await S.getByRole('link', { name: /Flu shots 2026/ }).waitFor({ state: 'detached', timeout: 5000 });
ok(true, 'doc made private disappears live for Sam');
ok(!(await samAct()).includes('Flu shot'), 'Wall entry scrubbed when the doc became private');
ok(!(await samBell()).includes('Flu shot'), "Sam's notification scrubbed when the doc became private");
await A.keyboard.press('Escape');

// Info cards
await A.goto(`${BASE}/vault/notes`);
const wifi = A.locator('li', { has: A.getByRole('heading', { name: 'Home Wi-Fi' }) });
await wifi.waitFor();
ok((await wifi.textContent()).includes('••••••••') && !(await wifi.textContent()).includes('sunflower'), 'secret masked before tap');
await wifi.getByRole('button', { name: 'Tap to reveal' }).click();
await wifi.getByText('sunflower-maple-42').waitFor();
ok(true, 'secret revealed after tap');
await wifi.getByRole('button', { name: /Hide/ }).click();
await wifi.getByText('sunflower-maple-42').waitFor({ state: 'detached' });
ok(true, 'hide masks again');
await S.goto(`${BASE}/vault/notes`);
await S.getByRole('heading', { name: 'Home Wi-Fi' }).waitFor();
ok((await S.getByRole('heading', { name: 'Passport numbers' }).count()) === 0, "Alex's private card hidden from Sam");

// New card, visible live to Sam
await visible(A.getByRole('button', { name: 'New info card' })).click();
const nf = A.getByRole('dialog', { name: 'New info card' });
await nf.getByRole('radio', { name: /Codes & PINs/ }).click();
await nf.getByLabel('Title').fill('Bike lock');
await nf.getByLabel('Field 1 value').fill('3141');
await nf.getByRole('button', { name: 'Save card' }).click();
await S.getByRole('heading', { name: 'Bike lock' }).waitFor({ timeout: 5000 });
ok(true, 'new info card appears live for Sam');
const bike = S.locator('li', { has: S.getByRole('heading', { name: 'Bike lock' }) });
ok(!(await bike.textContent()).includes('3141'), 'new secret is masked for Sam');

// Adults-only info cards are hidden from children (Mia)
const mia = await session('mia@hearth.test');
await mia.page.goto(`${BASE}/vault/notes`);
await mia.page.getByRole('heading', { name: 'Home Wi-Fi' }).waitFor();
ok((await mia.page.getByRole('heading', { name: 'Alarm & door codes' }).count()) === 0, 'child cannot see adults-only alarm codes card');
const alarm = (await (await A.request.get(`${BASE}/api/vault/notes`)).json()).find((n) => n.title === 'Alarm & door codes');
ok(alarm.visibility === 'adults', 'alarm codes seeded as adults-only');
ok((await mia.page.request.get(`${BASE}/api/vault/notes/${alarm.id}/reveal`)).status() === 404, 'child cannot reveal adults-only card via API');
const miaSearch = await (await mia.page.request.get(`${BASE}/api/search?q=alarm`)).json();
ok(!miaSearch.results.some((r) => r.module === 'vault'), 'adults-only card not searchable by a child');
const miaAdults = await mia.page.request.post(`${BASE}/api/vault/notes`, { data: { title: 'x', body: 'y', visibility: 'adults' } });
ok(miaAdults.status() === 403, 'child cannot create an adults-only card');
const card = (await (await A.request.get(`${BASE}/api/vault/documents`)).json()).find((d) => d.name === 'Health insurance card');
ok(card.visibility === 'adults', 'health insurance card seeded as adults-only');
await mia.ctx.close();

// Global search
const search = await (await A.request.get(`${BASE}/api/search?q=plumb`)).json();
ok(search.results.some((r) => r.module === 'vault' && r.link.startsWith('/vault/contacts/')), 'global search finds contacts');

// Mobile overflow + stacked nav
const mob = await session('alex@hearth.test', { width: 390, height: 844, mobile: true });
for (const p of ['/vault/contacts', '/vault/docs', '/vault/notes']) {
  await mob.page.goto(BASE + p);
  await settle(mob.page, 900);
  const over = await mob.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(over <= 0, `no horizontal overflow at 390px on ${p}`);
}
await mob.page.goto(`${BASE}/vault/contacts`);
await mob.page.locator('a[href^="/vault/contacts/"]', { hasText: "Emma Castillo" }).last().click();
await mob.page.getByRole('button', { name: 'Contacts' }).waitFor();
ok(!(await mob.page.getByRole('searchbox', { name: 'Search contacts' }).isVisible()), 'mobile: detail replaces the list (stacked navigation)');
await mob.ctx.close();

await alex.ctx.close();
await sam.ctx.close();

// ------------------------------------------------------------------------------------------
if (!NO_SHOTS) {
  console.log('Screenshots');
  for (const theme of ['light', 'dark']) {
    for (const vp of [{ tag: 'desktop', width: 1280, height: 800 }, { tag: 'mobile', width: 390, height: 844, mobile: true }]) {
      const { ctx, page } = await session('alex@hearth.test', { ...vp, theme });
      const n = (s) => `${vp.tag}-${theme}-${s}`;
      await page.goto(`${BASE}/vault/contacts`);
      await page.getByRole('heading', { name: 'Emergency' }).waitFor();
      await settle(page, 700);
      await shot(page, n('01-contacts'));
      await page.locator('a[href^="/vault/contacts/"]', { hasText: "Dr. Priya Patel" }).last().click();
      await page.getByRole('heading', { name: 'Dr. Priya Patel' }).waitFor();
      await settle(page);
      await shot(page, n('02-contact-detail'));
      await page.goto(`${BASE}/vault/contacts`);
      await visible(page.getByRole('button', { name: 'Add contact' })).click();
      await page.getByRole('dialog').waitFor();
      await settle(page, 500);
      await shot(page, n('03-contact-form'));
      await page.keyboard.press('Escape');

      await page.goto(`${BASE}/vault/docs`);
      await page.getByRole('heading', { name: 'Renew soon' }).waitFor();
      await settle(page, 900);
      await shot(page, n('04-docs'));
      await page.getByRole('link', { name: /Medical/ }).first().click();
      await page.getByRole('heading', { name: 'Medical' }).waitFor();
      await settle(page, 700);
      await shot(page, n('05-folder'));
      await page.getByRole('link', { name: /Immunization record – Mia/ }).click();
      await page.getByRole('dialog').locator('iframe').waitFor();
      await settle(page, 1200);
      await shot(page, n('06-preview-pdf'));
      await page.keyboard.press('Escape');
      await settle(page);
      await page.getByRole('link', { name: /Health insurance card/ }).click();
      await page.getByRole('dialog').locator('img').waitFor();
      await settle(page, 700);
      await shot(page, n('07-preview-image'));
      await page.keyboard.press('Escape');
      await settle(page);
      await page.getByRole('radio', { name: 'List' }).click();
      await settle(page);
      await shot(page, n('08-folder-list'));
      await page.getByRole('radio', { name: 'Grid' }).click();
      await page.locator('[data-testid=vault-file-input]').setInputFiles({ name: 'Dental X-ray.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
      await page.getByRole('dialog', { name: 'Upload documents' }).waitFor();
      await settle(page, 500);
      await shot(page, n('09-upload'));
      await page.keyboard.press('Escape');
      await settle(page);
      await page.getByRole('button', { name: 'New folder' }).first().click();
      await page.getByRole('dialog', { name: 'New folder' }).waitFor();
      await settle(page, 500);
      await shot(page, n('10-folder-form'));
      await page.keyboard.press('Escape');

      await page.goto(`${BASE}/vault/notes`);
      await page.getByRole('heading', { name: 'Home Wi-Fi' }).waitFor();
      await settle(page, 600);
      await shot(page, n('11-notes'));
      const card = page.locator('li', { has: page.getByRole('heading', { name: 'Home Wi-Fi' }) });
      await card.getByRole('button', { name: 'Tap to reveal' }).click();
      await card.getByText('sunflower-maple-42').waitFor();
      await settle(page, 300);
      await card.screenshot({ path: path.join(SHOTS, `${n('12-note-revealed')}.png`) });
      await visible(page.getByRole('button', { name: 'New info card' })).click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('dialog').getByRole('radio', { name: /Wi-Fi/ }).click();
      await settle(page, 500);
      await shot(page, n('13-note-form'));
      await ctx.close();
    }
  }
}

await browser.close();
const relevant = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e) || /vault/.test(e));
if (relevant.length) {
  console.error('Console errors:\n' + relevant.join('\n'));
  process.exit(1);
}
console.log(`\nAll ${passed} checks passed. No console errors.${NO_SHOTS ? '' : ` Screenshots in ${SHOTS}`}`);
