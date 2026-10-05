// Two-factor login browser checks (Playwright). Run against a freshly seeded, built instance:
//   DB_PATH=/tmp/h/h.db UPLOAD_DIR=/tmp/h/up npm run seed
//   DB_PATH=/tmp/h/h.db UPLOAD_DIR=/tmp/h/up PORT=4013 HEARTH_RATE_LIMITS=off npm start
//   BASE=http://localhost:4013 node scripts/e2e-2fa.mjs
// For desktop + phone, light + dark: turn 2FA on from Settings (the TOTP is computed from the
// manual setup key), save the recovery codes, sign in with password + code, sign in with a
// recovery code, make new codes, turn 2FA off. Screenshots of every screen go to screenshots/2fa/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { base32Decode, hotp, timeStep } from '../server/src/totp.js';

// Run Node and the browser in the demo family's time zone (seed.js DEMO_TZ), so "today" matches the server.
process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';

const BASE = process.env.BASE || 'http://localhost:4013';
const SHOTS = process.env.SHOTS || 'screenshots/2fa';
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const pageErrors = [];
let passed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Click after centring the element: Playwright's own scrolling leaves it under the fixed mobile bottom nav. */
async function tap(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  try {
    await locator.click({ timeout: 5000 });
  } catch (e) {
    await locator.page().screenshot({ path: `${SHOTS}/FAILED-tap.png` });
    throw e;
  }
}

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

/** Authenticator app stand-in. Codes are single-use per time step, so wait for a fresh step when needed. */
function authenticator(setupKey) {
  const key = base32Decode(setupKey);
  let last = -1;
  return {
    async next() {
      while (timeStep() + 1 <= last) await sleep(1000);
      last = Math.max(timeStep(), last + 1); // the server accepts ±1 step
      return hotp(key, last);
    },
    wrong() {
      const valid = [-1, 0, 1].map((o) => hotp(key, timeStep() + o));
      let n = 123456;
      while (valid.includes(String(n))) n++;
      return String(n);
    },
  };
}

for (const mobile of [false, true]) {
  for (const theme of ['light', 'dark']) {
    const tag = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
    const ctx = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
      isMobile: mobile,
      hasTouch: mobile,
      acceptDownloads: true,
    });
    await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${tag}: ${e.message}`));
    // Wrong codes/passwords are part of the flow, so their 400/401 responses are expected.
    page.on('console', (m) => m.type() === 'error' && !/status of 40[01]/.test(m.text()) && pageErrors.push(`${tag} console: ${m.text()}`));
    const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}-${tag}.png` });
    const dialog = page.getByRole('dialog');
    const card = page.locator('div.rounded-2xl', { has: page.getByRole('heading', { name: 'Two-factor login' }) }).last();
    const settle = () => page.waitForTimeout(350); // modal / toast animations

    let app;
    let codes;

    await check(`turn on 2FA from Settings (${tag})`, async () => {
      await page.goto(`${BASE}/login`);
      await page.fill('input[name=email]', 'alex@hearth.test');
      await page.fill('input[name=password]', 'hearth123');
      await page.click('button[type=submit]');
      await page.waitForURL('**/home');
      await page.goto(`${BASE}/settings`);
      await card.scrollIntoViewIfNeeded();
      await settle();
      await card.screenshot({ path: `${SHOTS}/01-card-off-${tag}.png` });
      await tap(card.getByRole('button', { name: 'Turn on' }));
      await settle();
      await dialog.getByLabel('Current password').fill('wrong-password');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByText('Current password is incorrect').waitFor();
      await dialog.getByLabel('Current password').fill('hearth123');
      await shot('02-enable-password');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('img', { name: /QR code/ }).waitFor();
      const key = (await dialog.locator('code').textContent()).trim();
      assert.match(key, /^([A-Z2-7]{4} )+[A-Z2-7]{4}$/);
      app = authenticator(key);
      const codeInput = dialog.getByLabel('6-digit code from the app');
      if (!mobile) assert.ok(await codeInput.evaluate((el) => el === document.activeElement), 'code field focused');
      assert.equal(await codeInput.getAttribute('inputmode'), 'numeric');
      assert.equal(await codeInput.getAttribute('autocomplete'), 'one-time-code');
      // QR image actually decodes as an SVG image.
      assert.ok(await dialog.getByRole('img', { name: /QR code/ }).evaluate((img) => img.complete && img.naturalWidth > 0));
      await settle();
      await shot('03-enable-scan');
      await codeInput.fill(app.wrong()); // auto-submits at 6 digits
      await dialog.getByText("That code didn't match", { exact: false }).waitFor();
      assert.equal(await codeInput.inputValue(), '', 'wrong code cleared');
      await settle();
      await shot('04-enable-wrong-code');
      await codeInput.fill(await app.next());
      const list = dialog.getByRole('list', { name: 'Recovery codes' });
      await list.waitFor();
      codes = await list.locator('li').allTextContents();
      assert.equal(codes.length, 10);
      for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      // Can't be dismissed before confirming.
      assert.ok(await dialog.getByRole('button', { name: 'Done' }).isDisabled());
      await page.keyboard.press('Escape');
      await settle();
      assert.ok(await list.isVisible(), 'Esc does not close the recovery codes');
      const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
      assert.equal(download.suggestedFilename(), 'hearth-recovery-codes.txt');
      const txt = fs.readFileSync(await download.path(), 'utf8');
      for (const c of codes) assert.ok(txt.includes(c), 'download has every code');
      await settle();
      await shot('05-recovery-codes');
      await dialog.getByRole('checkbox', { name: 'I saved my recovery codes' }).check({ force: true });
      await dialog.getByRole('button', { name: 'Done' }).click();
      await dialog.waitFor({ state: 'detached' });
      await card.getByText('10 of 10 recovery codes left').waitFor();
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: `${SHOTS}/06-card-on-${tag}.png` });
    });

    // (API logout: on phones the success toast can sit over Settings' "Sign out" button.)
    const signOut = async () => {
      assert.ok((await page.request.post(`${BASE}/api/auth/logout`)).ok());
      // A distinct URL: the app may already have redirected itself to /login with a "from" state,
      // which a same-URL navigation would keep.
      await page.goto(`${BASE}/login?signed-out`);
    };
    const passwordStep = async () => {
      await page.fill('input[name=email]', 'alex@hearth.test');
      await page.fill('input[name=password]', 'hearth123');
      await page.click('button[type=submit]');
      await page.getByRole('heading', { name: 'Two-factor login' }).waitFor();
    };

    await check(`sign in with password + authenticator code (${tag})`, async () => {
      await signOut();
      await passwordStep();
      const input = page.getByLabel('Authentication code');
      assert.ok(await input.evaluate((el) => el === document.activeElement), 'code field focused');
      assert.equal(await input.getAttribute('autocomplete'), 'one-time-code');
      await settle();
      await shot('07-login-code');
      // Back returns to the password step with the email kept.
      await page.getByRole('button', { name: 'Back to sign in' }).click();
      assert.equal(await page.inputValue('input[name=email]'), 'alex@hearth.test');
      assert.ok(await page.locator('input[name=password]').evaluate((el) => el === document.activeElement), 'password focused');
      await page.fill('input[name=password]', 'hearth123');
      await page.click('button[type=submit]');
      await input.waitFor();
      // Auto-submit at 6 digits + Enter right after must send one request (one try used).
      let codeRequests = 0;
      const countCodes = (r) => r.url().endsWith('/api/auth/login/2fa') && codeRequests++;
      page.on('request', countCodes);
      await input.evaluate(async (el, code) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, code);
        el.dispatchEvent(new Event('input', { bubbles: true })); // auto-submits
        await new Promise((r) => setTimeout(r, 0));
        el.form.requestSubmit(); // Enter while the first request is in flight
      }, app.wrong());
      await page.getByText("That code didn't work", { exact: false }).waitFor();
      page.off('request', countCodes);
      assert.equal(codeRequests, 1, 'one request for a double submit');
      assert.equal(await input.inputValue(), '');
      assert.ok(await input.evaluate((el) => el === document.activeElement), 'refocused after a wrong code');
      await settle();
      await shot('08-login-wrong-code');
      await input.fill(await app.next());
      await page.waitForURL('**/home');
    });

    await check(`sign in with a recovery code (${tag})`, async () => {
      await signOut();
      await passwordStep();
      await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
      const input = page.getByLabel('Recovery code');
      assert.ok(await input.evaluate((el) => el === document.activeElement), 'recovery field focused');
      await input.fill(codes[0].toUpperCase());
      await settle();
      await shot('09-login-recovery');
      await page.getByRole('button', { name: 'Verify' }).click();
      await page.waitForURL('**/home');
      await page.goto(`${BASE}/settings`);
      await card.getByText('9 of 10 recovery codes left').waitFor();
    });

    await check(`make new recovery codes (${tag})`, async () => {
      await tap(card.getByRole('button', { name: 'New codes' }));
      await settle();
      await dialog.getByLabel('Authentication code').fill(codes[0]); // already used
      await dialog.getByRole('button', { name: 'Create codes' }).click();
      await dialog.getByText("That code didn't work", { exact: false }).waitFor();
      await settle();
      await shot('10-regenerate');
      await dialog.getByLabel('Authentication code').fill(await app.next());
      await dialog.getByRole('button', { name: 'Create codes' }).click();
      const list = dialog.getByRole('list', { name: 'Recovery codes' });
      await list.waitFor();
      const fresh = await list.locator('li').allTextContents();
      assert.equal(fresh.length, 10);
      assert.ok(!fresh.includes(codes[1]));
      await dialog.getByRole('checkbox', { name: 'I saved my recovery codes' }).check({ force: true });
      await dialog.getByRole('button', { name: 'Done' }).click();
      await card.getByText('10 of 10 recovery codes left').waitFor();
      codes = fresh;
    });

    await check(`turn 2FA off (${tag})`, async () => {
      await tap(card.getByRole('button', { name: 'Turn off' }));
      await settle();
      // A wrong password is reported on the password field (and doesn't use up the code).
      await dialog.getByLabel('Current password').fill('wrong-password');
      await dialog.getByLabel('Authentication code').fill(await app.next());
      await dialog.getByRole('button', { name: 'Turn off' }).click();
      await dialog.getByText('Current password is incorrect').waitFor();
      assert.equal(await dialog.getByLabel('Current password').getAttribute('aria-invalid'), 'true');
      assert.equal(await dialog.getByLabel('Authentication code').getAttribute('aria-invalid'), null);
      await settle();
      await shot('11-disable-wrong-password');
      await dialog.getByLabel('Current password').fill('hearth123');
      await shot('12-disable');
      await dialog.getByRole('button', { name: 'Turn off' }).click();
      await dialog.waitFor({ state: 'detached' });
      await card.getByRole('button', { name: 'Turn on' }).waitFor();
      // Plain password sign-in works again.
      await signOut();
      await page.fill('input[name=email]', 'alex@hearth.test');
      await page.fill('input[name=password]', 'hearth123');
      await page.click('button[type=submit]');
      await page.waitForURL('**/home');
    });

    await ctx.close();
  }
}

await browser.close();
assert.deepEqual(pageErrors, [], 'no page errors');
console.log(`\n${passed} checks passed; screenshots in ${SHOTS}/`);
