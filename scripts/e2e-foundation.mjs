// Foundation browser regression checks (Playwright). Run against a seeded, built instance:
//   PORT=4012 DB_PATH=/tmp/h/h.db UPLOAD_DIR=/tmp/h/up npm run seed
//   PORT=4012 DB_PATH=/tmp/h/h.db UPLOAD_DIR=/tmp/h/up npm start
//   BASE=http://localhost:4012 node scripts/e2e-foundation.mjs
// Exits non-zero on the first failed check. (Not part of `npm test`, which needs no browser.)
import assert from 'node:assert/strict';
import { chromium, request } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4012';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const pageErrors = [];
let passed = 0;

async function newPage({ mobile = false, theme = 'light' } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));
  return { ctx, page };
}
async function login(page, email = 'alex@hearth.test') {
  const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert.ok(r.ok(), `login ${email}`);
}
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. Typing into a modal whose form state lives in the parent must not lose focus.
for (const mobile of [false, true]) {
  await check(`modal keeps focus while typing (${mobile ? 'mobile' : 'desktop'})`, async () => {
    const { ctx, page } = await newPage({ mobile });
    await login(page);
    await page.goto(`${BASE}/family`);
    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).click();
    await page.keyboard.type('Zed', { delay: 20 });
    await dialog.getByRole('switch').click();
    await dialog.getByLabel('Email', { exact: true }).click();
    await page.keyboard.type('zed@example.test', { delay: 20 });
    await dialog.getByLabel('Password', { exact: true }).click();
    await page.keyboard.type('secret123', { delay: 20 });
    await dialog.getByLabel('Birthday').fill('2015-05-05');
    assert.equal(await dialog.getByLabel('Name', { exact: true }).inputValue(), 'Zed');
    assert.equal(await dialog.getByLabel('Email', { exact: true }).inputValue(), 'zed@example.test');
    assert.equal(await dialog.getByLabel('Password', { exact: true }).inputValue(), 'secret123');
    await ctx.close();
  });
}

// 1b. Every overlay moves focus inside itself on open.
const focusInDialog = (page) => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
for (const mobile of [false, true]) {
  await check(`overlays take focus on open (${mobile ? 'mobile' : 'desktop'})`, async () => {
    const { ctx, page } = await newPage({ mobile });
    await login(page);
    await page.goto(`${BASE}/family`);
    await page.getByRole('button', { name: 'Add member' }).click();
    await page.waitForTimeout(150);
    assert.ok(await focusInDialog(page), 'Add member modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Delete family' }).click();
    await page.waitForTimeout(150);
    assert.ok(await focusInDialog(page), 'Delete family modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'New code' }).click();
    await page.waitForTimeout(150);
    assert.ok(await focusInDialog(page), 'Confirm dialog');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'New code'); // non-destructive: confirm focused
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // destructive confirm: Cancel gets focus so Enter can't delete by accident
    await page.getByRole('button', { name: /Actions for Sam/ }).click();
    await page.getByRole('menuitem', { name: 'Remove from family' }).click();
    await page.waitForTimeout(150);
    assert.ok(await focusInDialog(page), 'Danger confirm dialog');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await page.keyboard.press('Enter'); // activates Cancel
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.ok(await page.getByText('Sam Rivera').first().isVisible(), 'Sam not removed');
    await ctx.close();
  });
}

await check('search palette: Ctrl+K, type, Enter navigates', async () => {
  const { ctx, page } = await newPage();
  await login(page);
  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('main h1');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  assert.ok(await focusInDialog(page), 'palette focused');
  await page.keyboard.type('sa');
  assert.equal(await page.getByRole('combobox').inputValue(), 'sa');
  await page.getByRole('option', { name: /Sam Rivera/ }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/family');
  await ctx.close();
});

// 2. Exactly one notification bell (one live subscription) at each breakpoint; no console errors on public pages.
for (const mobile of [false, true]) {
  await check(`single notification bell (${mobile ? 'mobile' : 'desktop'})`, async () => {
    const { ctx, page } = await newPage({ mobile });
    await login(page);
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('main h1');
    assert.equal(await page.locator('button[aria-label^="Notifications"]').count(), 1);
    await ctx.close();
  });
}

// 3. Menu: Esc returns focus to the trigger; ARIA lives on the trigger button.
await check('menu keyboard + focus return', async () => {
  const { ctx, page } = await newPage();
  await login(page);
  await page.goto(`${BASE}/family`);
  const trigger = page.getByRole('button', { name: /Actions for Sam/ });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('[role=menu]');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Actions for Sam Rivera');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await ctx.close();
});

// 4. Two tabs, two families: each tab keeps its own family.
await check('per-tab active family', async () => {
  const { ctx, page } = await newPage();
  await login(page);
  const name = `Second Home ${Date.now()}`;
  const created = await page.request.post(`${BASE}/api/families`, { data: { name } });
  const second = await created.json();
  const exact = new RegExp(name); // unique per run (timestamped), so a substring match is exact enough
  try {
    await page.request.post(`${BASE}/api/families/${second.id}/activate`);
    // tab A: explicitly switch to Rivera through the UI
    await page.goto(`${BASE}/home`);
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await page.getByRole('menuitem', { name: /Rivera Family/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Rivera Family'));
    // tab B (same session): switch to the second family
    const tabB = await ctx.newPage();
    await tabB.goto(`${BASE}/home`);
    await tabB.getByRole('button', { name: /Rivera Family/ }).first().click();
    await tabB.getByRole('menuitem', { name: exact }).click();
    await tabB.waitForFunction((n) => document.querySelector('aside')?.textContent?.includes(n), name);
    // tab A still Rivera after a reload + immediate navigation, and its API calls are pinned
    await page.reload();
    await page.goto(`${BASE}/family`);
    await page.waitForSelector('main h2');
    assert.equal(await page.locator('main h2').first().textContent(), 'Rivera Family');
    const pinned = await page.evaluate(async () => (await (await fetch('/api/family', { headers: { 'X-Family-Id': sessionStorage.getItem('hearth-tab-family') } })).json()).name);
    assert.equal(pinned, 'Rivera Family');
    // delete the extra family through the UI
    await tabB.goto(`${BASE}/family`);
    await tabB.getByRole('button', { name: 'Delete family' }).click();
    await tabB.getByRole('dialog').getByRole('textbox').fill(name);
    await tabB.getByRole('button', { name: 'Delete forever' }).click();
    await tabB.waitForURL('**/home');
    // the app shell must actually render for the next family (not a stuck splash), with one toast
    await tabB.locator('aside').getByText('Rivera Family').first().waitFor({ timeout: 8000 });
    await tabB.waitForTimeout(800);
    assert.equal(await tabB.locator('[role=status]').filter({ hasText: /deleted|removed/ }).count(), 1, 'exactly one toast after delete');
  } finally {
    // make sure the extra family never leaks into later runs, even when a step above failed
    await page.request.delete(`${BASE}/api/family`, {
      headers: { 'X-Family-Id': String(second.id) },
      data: { confirm_name: name },
    }).catch(() => {});
    await ctx.close();
  }
});

// 5. /join/<code> signed out -> sign in -> "already in" screen; new user -> register -> join step prefilled.
await check('join link flows', async () => {
  const { ctx, page } = await newPage({ mobile: true });
  await page.goto(`${BASE}/join/HRTH-2026`);
  await page.getByText("You're invited!").waitFor();
  await page.getByText('Rivera Family').first().waitFor();
  await page.getByRole('link', { name: 'I already have an account' }).click();
  await page.fill('input[name=email]', 'sam@hearth.test');
  await page.fill('input[name=password]', 'hearth123');
  await page.click('button[type=submit]');
  await page.getByText("You're already in Rivera Family").waitFor();
  // signed in + /register?code= -> join screen; Register's "Sign in" link keeps the code
  await page.goto(`${BASE}/register?code=HRTH-2026`);
  await page.waitForURL('**/join/HRTH-2026');
  await ctx.close();
  const anon = await newPage();
  await anon.page.goto(`${BASE}/register?code=HRTH-2026`);
  await anon.page.getByRole('link', { name: 'Sign in' }).click();
  await anon.page.fill('input[name=email]', 'mia@hearth.test');
  await anon.page.fill('input[name=password]', 'hearth123');
  await anon.page.click('button[type=submit]');
  await anon.page.getByText("You're already in Rivera Family").waitFor();
  await anon.ctx.close();

  const n = await newPage();
  await n.page.goto(`${BASE}/join/HRTH-2026`);
  await n.page.getByRole('link', { name: 'Create an account' }).click();
  await n.page.getByLabel('Your name').fill('Jo Newcomer');
  await n.page.getByLabel('Email').fill(`jo${Date.now()}@example.test`);
  await n.page.getByLabel('Password', { exact: true }).fill('secret123');
  await n.page.getByRole('button', { name: 'Continue' }).click();
  // the code survives sign-up: the new account lands on the join confirmation
  await n.page.getByText('Join Rivera Family?').waitFor();
  await n.page.getByRole('button', { name: 'Join Rivera Family' }).click();
  await n.page.waitForURL('**/home');
  // leave again so the demo family stays at 4 members
  const api = n.page.request;
  const me = await (await api.get(`${BASE}/api/auth/me`)).json();
  await api.delete(`${BASE}/api/family/members/${me.user.id}`, { headers: { 'X-Family-Id': String(me.active_family_id) } });
  await n.ctx.close();
});

// 6. Invite code hidden from non-admins.
await check('invite code hidden for members', async () => {
  const { ctx, page } = await newPage();
  await login(page, 'sam@hearth.test');
  await page.goto(`${BASE}/family`);
  await page.getByText('only admins can share it').waitFor();
  assert.equal(await page.locator('[data-testid=invite-code]').count(), 0);
  await ctx.close();
});

// 7. Rate limit message reaches the UI.
await check('429 shown on login', async () => {
  const rc = await request.newContext();
  for (let i = 0; i < 11; i++) await rc.post(`${BASE}/api/auth/login`, { data: { email: 'ratelimit@example.test', password: 'x' } });
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', 'ratelimit@example.test');
  await page.fill('input[name=password]', 'whatever');
  await page.click('button[type=submit]');
  await page.getByText('Too many attempts').waitFor();
  await ctx.close();
  await rc.dispose();
});

// 7b. Leaving the active family through the UI lands on the next family with exactly one toast.
await check('leave family via UI -> next family, one toast', async () => {
  const { ctx, page } = await newPage();
  await login(page, 'sam@hearth.test');
  const name = `Sam Side ${Date.now()}`;
  const side = await (await page.request.post(`${BASE}/api/families`, { data: { name } })).json();
  const admin = await request.newContext();
  await admin.post(`${BASE}/api/auth/login`, { data: { email: 'alex@hearth.test', password: 'hearth123' } });
  try {
    await page.goto(`${BASE}/home`);
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    await page.getByRole('menuitem', { name: /Rivera Family/ }).click();
    await page.goto(`${BASE}/family`);
    await page.waitForSelector('main h2');
    await page.getByRole('button', { name: /^Leave Rivera Family$/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave family' }).click();
    await page.waitForURL('**/home');
    await page.locator('aside').getByText(name).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
    const toasts = page.locator('[role=status]').filter({ hasText: /Rivera Family/ });
    assert.equal(await toasts.count(), 1, 'exactly one toast after leaving');
    assert.match(await toasts.first().innerText(), /You left Rivera Family/);
  } finally {
    // restore demo state: Sam rejoins Rivera as a member; remove the side family
    await page.request.post(`${BASE}/api/families/join`, { data: { invite_code: 'HRTH-2026' } }).catch(() => {});
    const fam = await (await admin.get(`${BASE}/api/family`)).json();
    const sam = fam.members.find((m) => m.email === 'sam@hearth.test');
    if (sam) await admin.patch(`${BASE}/api/family/members/${sam.id}`, { data: { role: 'member' }, headers: { 'X-Family-Id': String(fam.id) } });
    await page.request.delete(`${BASE}/api/family`, { headers: { 'X-Family-Id': String(side.id) }, data: { confirm_name: name } }).catch(() => {});
    await admin.dispose();
    await ctx.close();
  }
});

// 8. Being removed from the active family: live toast, cache cleared, moved on.
await check('removed from family -> toast + redirect', async () => {
  const { ctx, page } = await newPage();
  // In-flight requests for the lost family get 403 NOT_MEMBER by design; ignore those console lines.
  page.on('console', (m) => {
    if (/status of 403/.test(m.text())) pageErrors.splice(pageErrors.lastIndexOf(`console: ${m.text()}`), 1);
  });
  await login(page, 'sam@hearth.test');
  await page.goto(`${BASE}/family`);
  await page.waitForSelector('main h2');
  const admin = await request.newContext();
  await admin.post(`${BASE}/api/auth/login`, { data: { email: 'alex@hearth.test', password: 'hearth123' } });
  const fam = await (await admin.get(`${BASE}/api/family`)).json();
  const sam = fam.members.find((m) => m.email === 'sam@hearth.test');
  await admin.delete(`${BASE}/api/family/members/${sam.id}`, { headers: { 'X-Family-Id': String(fam.id) } });
  await page.getByText('You were removed from Rivera Family').waitFor({ timeout: 8000 });
  await page.waitForURL('**/onboarding');
  assert.equal(await page.locator('[role=alert]').count(), 0, 'no error toast/state for NOT_MEMBER');
  // restore demo state: Sam rejoins with the invite code and gets their role back
  await page.request.post(`${BASE}/api/families/join`, { data: { invite_code: 'HRTH-2026' } });
  await admin.patch(`${BASE}/api/family/members/${sam.id}`, { data: { role: 'member' }, headers: { 'X-Family-Id': String(fam.id) } });
  await admin.dispose();
  await ctx.close();
});

await browser.close();
const unexpected = pageErrors.filter((e) => !/429|Too Many Requests/.test(e));
if (unexpected.length) {
  console.error('page errors:\n' + unexpected.join('\n'));
  process.exit(1);
}
console.log(`\n${passed} checks passed, no page errors`);
