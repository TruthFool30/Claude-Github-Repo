// Bank statement import + insights browser test, against the real server.
//   BASE=http://localhost:4391 node scripts/e2e-import.mjs        (SHOTS=/some/dir to save screenshots)
// Needs a FRESHLY seeded instance (npm run seed; it imports statements and checks duplicates, so a
// second run on the same DB fails) started with HEARTH_RATE_LIMITS=off, and a built client.
// Uploads the synthetic statements in server/test/fixtures/statements/ (Sep–Oct 2026, made-up data).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';
const BASE = process.env.BASE || 'http://localhost:4391';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const FIX = new URL('../server/test/fixtures/statements/', import.meta.url);
const file = (name, mimeType) => ({ name, mimeType, buffer: readFileSync(new URL(name, FIX)) });
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PASSWORD = 'sample-pass-123';
// A non-localhost name for the same server: http + not loopback = NOT a secure context.
const INSECURE = `http://hearth-lan.test:${new URL(BASE).port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
  args: ['--host-resolver-rules=MAP hearth-lan.test 127.0.0.1'],
});
const errors = [];
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

async function open(email, { viewport = { width: 1280, height: 860 }, theme = 'light', base = BASE } = {}) {
  const mobile = viewport.width < 600;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript((t) => window.localStorage?.setItem('hearth-theme', t), theme); // null inside PDF viewer frames
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
    // 400s are the expected PASSWORD_REQUIRED / BAD_PASSWORD / UNSUPPORTED answers.
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|404|403)/.test(m.text())) errors.push(`${email}: ${m.text()}`);
  });
  if (base === BASE) {
    const r = await page.request.post(`${base}/api/auth/login`, { data: { email, password: 'hearth123' } });
    assert.equal(r.status(), 200, `login ${email}`);
  } else {
    // Only the browser maps the fake host name, so sign in from inside the page.
    await page.goto(`${base}/login`);
    const status = await page.evaluate((e) => fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'hearth123' }) }).then((r) => r.status), email);
    assert.equal(status, 200, `login ${email}`);
  }
  return { ctx, page, api: (path) => page.request.get(`${base}/api${path}`).then((r) => r.json()) };
}

const shot = async (page, name, full = true) => {
  if (!SHOTS) return;
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
};

const noHorizontalScroll = async (page, where) => {
  const bad = await page.evaluate(() => {
    const vw = window.innerWidth;
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      }
      return false;
    };
    const out = [];
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > vw + 1 && !inScroller(el)) out.push(`${el.tagName}.${String(el.className).slice(0, 50)} right=${Math.round(r.right)}`);
    }
    return out.slice(0, 5);
  });
  assert.deepEqual(bad, [], `${where}: elements overflow the viewport`);
};

const segment = (page, name) => page.getByRole('radio', { name }).first();

/** Upload one statement and wait for the review step (handles the password prompt). */
async function upload(page, f, { password, wrongFirst, tag } = {}) {
  await page.goto(`${BASE}/budget/import`);
  await page.getByText('Drop a bank statement here').waitFor();
  await page.locator('input[type=file]').setInputFiles(f);
  if (password) {
    const pw = page.getByLabel('Statement password');
    await pw.waitFor();
    await page.getByText('often with your NRIC or date of birth').waitFor();
    assert.equal(await pw.evaluate((el) => el === document.activeElement), true, 'password field focused');
    if (wrongFirst) {
      await pw.fill('not-the-password');
      await page.getByRole('button', { name: 'Unlock and read' }).click();
      await page.getByText("That password didn't open the file").waitFor();
      assert.equal(await pw.inputValue(), '', 'wrong password cleared');
      await page.getByText('often with your NRIC or date of birth').waitFor(); // hint stays next to the error
      if (tag) await shot(page, `02-password-${tag}`, false);
    }
    await pw.fill(password);
    await pw.press('Enter');
  }
  await page.getByText('Step 2 of 4').waitFor({ timeout: 30_000 });
}

/** review → recurring → visibility → commit. Returns the import id. */
async function finish(page, { visibility, tag, label }) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText(/Step [34] of 4/).waitFor();
  if (await page.getByText('Step 3 of 4').count()) {
    // Suggestions matching an existing bill start off; the rest start on.
    for (const sw of await page.getByRole('switch', { name: /Create a monthly bill for/ }).all()) {
      const card = sw.locator('xpath=ancestor::div[contains(@class,"gap-3")][1]');
      const existing = (await card.getByText('Already one of your bills').count()) > 0;
      assert.equal(await sw.getAttribute('aria-checked'), existing ? 'false' : 'true', 'bill toggle default');
    }
    if (tag) await shot(page, `05-recurring-${tag}`);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByText('Step 4 of 4').waitFor();
  assert.equal(await page.getByRole('radio', { name: /Adults only/ }).getAttribute('aria-checked'), 'true', 'adults default');
  assert.equal(await page.getByRole('radio', { name: /Everyone/ }).count(), 0, 'no Everyone option for imports');
  if (visibility === 'private') {
    // Radio group keyboard pattern: arrow keys move focus and selection.
    await page.getByRole('radio', { name: /Adults only/ }).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('radio', { name: /Only me/ }).getAttribute('aria-checked'), 'true', 'ArrowDown selects Only me');
    assert.equal(await page.getByRole('radio', { name: /Only me/ }).evaluate((el) => el === document.activeElement), true, 'focus follows');
  }
  if (tag) await shot(page, `06-visibility-${tag}`);
  const commit = page.waitForResponse((r) => /\/api\/budget\/imports\/[^/]+\/commit$/.test(r.url()));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const res = await commit;
  assert.equal(res.status(), 201);
  const body = await res.json();
  body.sent = res.request().postDataJSON();
  assert.equal(body.import.account_label, label);
  assert.equal(body.import.visibility, visibility);
  await page.getByText(`Imported ${body.created} transaction`).waitFor();
  await page.getByText(visibility === 'private' ? 'visible to only you' : 'visible to adults only').waitFor();
  if (tag) await shot(page, `07-done-${tag}`);
  return body;
}

/** History filtered to one import (the success screen's link and the Wall's activity link). */
async function checkImportFilter(page, id, label, count, tag) {
  await page.goto(`${BASE}/budget/transactions?import=${id}`);
  await page.getByText(`Imported from ${label}`).waitFor();
  await page.getByText('This import, all months').waitFor();
  await page.getByText(`${count} transactions`, { exact: false }).first().waitFor();
  assert.ok(await page.getByText(`Imported · ${label}`).count() >= 1, 'imported tag on rows');
  await noHorizontalScroll(page, `import filter ${tag}`);
  if (tag) await shot(page, `11-transactions-${tag}`, !tag.startsWith('mobile'));
}

try {
  console.log(`Import e2e against ${BASE} (real server)`);
  const alex = await open('alex@hearth.test');
  const A = alex.page;
  const sam = await open('sam@hearth.test');
  const mia = await open('mia@hearth.test');
  const cats = await alex.api('/budget/categories');
  const catId = (n) => cats.find((c) => c.name === n).id;

  // ---- 1. DBS CSV, desktop light: review, bulk merchant, learning, adults only --------------
  await A.goto(`${BASE}/budget/transactions`);
  await A.getByRole('button', { name: 'Import statement' }).first().click();
  await A.waitForURL('**/budget/import');
  await A.getByText('never stored').waitFor();
  await A.getByText('Where to get a statement').waitFor();
  await A.getByText(/Account → Transaction History → Export, choose CSV/).waitFor();
  assert.equal(await A.getByText("You're not on a secure").count(), 0, 'no insecure warning on localhost');
  await A.getByText('No statements imported yet.').waitFor();
  await shot(A, '01-upload-desktop-light');
  // Sam keeps History open on October to see the import arrive live.
  await sam.page.goto(`${BASE}/budget/transactions?month=2026-10`);
  await sam.page.getByText('October 2026').first().waitFor();

  await upload(A, file('dbs.csv', 'text/csv'));
  await A.getByText('DBS ••4821').first().waitFor();
  await A.getByText(/1 Sep 2026 – 31 Oct 2026/).waitFor();
  await A.getByText('of 17 transactions selected').waitFor();
  assert.equal(await A.getByText('Already in Hearth · skipped').count(), 0, 'first import has no duplicates');
  assert.ok(await A.getByText('Suggested', { exact: true }).count() > 0, '"Suggested" hints');
  // Long account numbers are masked by the server before they reach the page.
  assert.equal(await A.getByText(/4111 1111 1111 1111|1234567890/).count(), 0, 'card/account numbers masked');
  await A.getByText(/GRAB\*TRIP CARD ••1111/).waitFor();
  await noHorizontalScroll(A, 'review desktop');
  await shot(A, '03-review-desktop-light', false);

  // Bulk: re-categorise one NTUC row → offer to set the other 2 from the same merchant.
  const ntuc = A.getByRole('combobox', { name: /Category for POS NTUC FP-SAMPLE BRANCH|Category for NTUC FP-SAMPLE BRANCH/ });
  assert.equal(await ntuc.count(), 3);
  await ntuc.first().selectOption({ label: 'Other' });
  await A.getByText(/Use Other for 2 other transactions from this merchant/).waitFor();
  await shot(A, '04-bulk-desktop-light', false);
  await A.getByRole('button', { name: 'Set for all' }).click();
  await A.getByText('Updated 3 transactions').waitFor();
  for (const s of await ntuc.all()) assert.equal(await s.inputValue(), String(catId('Other')));
  // Uncategorized filter keeps a row on screen after it gets a category.
  await segment(A, /Uncategorized \d+/).click();
  const hw = A.getByRole('combobox', { name: /Category for .*SAMPLE HARDWARE TRADING/ });
  if (await hw.count()) {
    await hw.selectOption({ label: 'Shopping' });
    assert.equal(await hw.count(), 1, 'stays listed');
  }
  await segment(A, /^All \d+/).click();
  { const cb = A.getByRole('checkbox', { name: /Import .*PAYNOW TRANSFER TO SAMPLE FRIEND/ }); await cb.focus(); await A.keyboard.press('Space'); } // leave one out (keyboard)
  await A.getByText('16 of 17 transactions selected').waitFor();
  // Bulk select controls.
  await A.getByRole('button', { name: 'Deselect all' }).click();
  await A.getByText('0 of 17 transactions selected').waitFor();
  await A.getByRole('button', { name: 'Select all', exact: true }).click();
  await A.getByText('17 of 17 transactions selected').waitFor();
  await A.getByRole('button', { name: 'Untick all income' }).click();
  await A.getByText('14 of 17 transactions selected').waitFor();
  await A.getByRole('button', { name: 'Select all', exact: true }).click();
  { const cb = A.getByRole('checkbox', { name: /Import .*PAYNOW TRANSFER TO SAMPLE FRIEND/ }); await cb.focus(); await A.keyboard.press('Space'); }
  await A.getByText('16 of 17 transactions selected').waitFor();
  // Transfer between own accounts: muted, not counted in the selected totals.
  const landlord = A.locator('div.px-3', { hasText: 'SAMPLE LANDLORD' }).first();
  const outBefore = await A.getByText(/transactions selected/).locator('xpath=..').innerText();
  // No transfer chip on ordinary rows: marking one lives in the row's ⋯ menu (reachable by keyboard and touch).
  assert.equal(await A.getByRole('button', { name: /^Transfer between my accounts/ }).count(), 0, 'no transfer chips before marking');
  await landlord.getByRole('button', { name: /^More for / }).click();
  await A.getByRole('menuitem', { name: 'Mark as transfer' }).click();
  assert.equal(await landlord.getByRole('button', { name: /^Transfer between my accounts/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await A.getByRole('button', { name: /^Transfer between my accounts/ }).count(), 1, 'chip only on the transfer row');
  await landlord.getByText('Not counted as income or spending').waitFor();
  assert.notEqual(await A.getByText(/transactions selected/).locator('xpath=..').innerText(), outBefore, 'transfer left out of the totals');
  await shot(A, '04b-transfer-desktop-light', false);
  // Start over asks first when something was changed.
  await A.getByRole('button', { name: 'Start over' }).click();
  await A.getByRole('dialog').getByText('Start over?').waitFor();
  await A.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await A.getByText('Step 2 of 4').waitFor();
  const dbs = await finish(A, { visibility: 'adults', tag: 'desktop-light', label: 'DBS ••4821' });
  assert.equal(dbs.created, 16);
  assert.equal(dbs.excluded, 1);
  const sentLandlord = dbs.sent.rows.find((r) => r.transfer);
  assert.ok(sentLandlord && dbs.sent.rows.filter((r) => r.transfer).length === 1, 'commit sends transfer: true for the marked row');
  assert.ok(dbs.sent.rows.every((r) => typeof r.transfer === 'boolean'), 'every row carries transfer');
  await A.getByText('1 left out').waitFor();
  ok(`DBS CSV: review, masked numbers, bulk merchant category, uncategorized filter, select/deselect/untick income, transfer toggle, start-over confirm, 16 imported (1 left out), adults only`);

  // Live: Sam's open History shows the imported rows without a reload.
  await sam.page.getByText('Imported · DBS ••4821').first().waitFor({ timeout: 15_000 });
  ok('Sam (adult) sees the adults-only import arrive live');

  await A.getByRole('link', { name: 'See transactions' }).click();
  await A.waitForURL(`**/budget/transactions?import=${dbs.import.id}`);
  await checkImportFilter(A, dbs.import.id, 'DBS ••4821', 16, 'desktop-light');
  await A.getByRole('button', { name: /imported from DBS ••4821/ }).first().click();
  const dlg = A.getByRole('dialog');
  await dlg.getByText('Imported · DBS ••4821').waitFor();
  await dlg.getByText('Visible to').waitFor();
  await shot(A, '12-detail-desktop-light', false);
  await dlg.getByRole('button', { name: 'Edit' }).click();
  await A.getByRole('radiogroup', { name: 'Who can see this transaction' }).waitFor();
  await A.getByRole('switch', { name: /This is a transfer between my own accounts/ }).or(A.getByText('This is a transfer between my own accounts')).first().waitFor();
  await shot(A, '13-edit-visibility-desktop-light', false);
  await A.keyboard.press('Escape');
  await A.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await A.waitForURL((u) => !u.search.includes('import='));
  // Round-2 server fields: assert them once the server returns them, otherwise say what was skipped.
  {
    const rows = await alex.api(`/budget/transactions?import_id=${dbs.import.id}`);
    if (rows.length && 'transfer' in rows[0]) {
      assert.equal(rows.filter((t) => t.transfer).length, 1, 'transfer stored');
      await A.goto(`${BASE}/budget/transactions?import=${dbs.import.id}`);
      await A.getByText('Transfer', { exact: true }).first().waitFor();
    } else console.log('    ⚠ skipped: server has no transactions[].transfer yet (Transfer badge not checked)');
    if (rows.length && 'merchant' in rows[0]) {
      const m = rows.find((t) => t.merchant && t.merchant !== t.description);
      if (m) await A.getByText(m.description, { exact: true }).first().waitFor(); // raw bank text as subtitle
      // Title casing keeps acronyms / vowel-less short tokens in capitals ("NTUC FP Sample…", "AIA Sample…").
      if (rows.some((t) => /ntuc/i.test(t.merchant ?? ''))) await A.getByText(/^NTUC FP\b/).first().waitFor();
      if (rows.some((t) => /aia/i.test(t.merchant ?? ''))) await A.getByText(/^AIA Sample/).first().waitFor();
    } else console.log('    ⚠ skipped: server has no transactions[].merchant yet (merchant title not checked)');
  }
  ok('import filter link (?import=) with "Imported from DBS ••4821 · Clear filter" chip, badges, detail, edit visibility');

  // ---- 2. POSB XLSX, desktop dark: learned categories --------------------------------------
  const dark = await open('alex@hearth.test', { theme: 'dark' });
  await upload(dark.page, file('posb.xlsx', XLSX));
  await dark.page.getByText('POSB ••1357').first().waitFor();
  const posbNtuc = dark.page.getByRole('combobox', { name: /Category for .*NTUC FP-SAMPLE BRANCH/ });
  assert.equal(await posbNtuc.first().inputValue(), String(catId('Other')), 'learned from the DBS import');
  assert.ok(await dark.page.getByText('Learned from you', { exact: true }).count() >= 3, '"Learned from you" hint');
  await shot(dark.page, '03-review-desktop-dark', false);
  const posb = await finish(dark.page, { visibility: 'adults', tag: 'desktop-dark', label: 'POSB ••1357' });
  await checkImportFilter(dark.page, posb.import.id, 'POSB ••1357', posb.created, 'desktop-dark');
  ok('POSB XLSX: merchant categories learned from the previous import ("Learned from you"), committed');

  // ---- 3. UOB protected PDF, mobile light: wrong password first, only me --------------------
  const mob = await open('alex@hearth.test', { viewport: { width: 390, height: 844 } });
  await upload(mob.page, file('uob-protected.pdf', PDF), { password: PASSWORD, wrongFirst: true, tag: 'mobile-light' });
  await mob.page.getByText('UOB ••7890').first().waitFor();
  await noHorizontalScroll(mob.page, 'review mobile');
  await shot(mob.page, '03-review-mobile-light', false);
  const uob = await finish(mob.page, { visibility: 'private', tag: 'mobile-light', label: 'UOB ••7890' });
  await checkImportFilter(mob.page, uob.import.id, 'UOB ••7890', uob.created, 'mobile-light');
  ok('UOB password PDF: wrong password → retry → only me, committed (mobile)');

  // ---- 4. UOB PDF (same account) → everything is a duplicate --------------------------------
  const mobDark = await open('alex@hearth.test', { viewport: { width: 390, height: 844 }, theme: 'dark' });
  await upload(mobDark.page, file('uob.pdf', PDF));
  await mobDark.page.getByText(/17 already in Hearth/).waitFor();
  await segment(mobDark.page, /Duplicates 17/).click();
  assert.equal(await mobDark.page.getByText('Already in Hearth · skipped').count(), 17);
  assert.equal(await mobDark.page.getByRole('checkbox', { name: /^Import / }).first().isChecked(), false, 'duplicates pre-excluded');
  assert.equal(await mobDark.page.getByRole('button', { name: 'Continue' }).isDisabled(), true, 'nothing to import');
  await shot(mobDark.page, '03-review-duplicates-mobile-dark', false);
  ok('re-importing the same UOB account: all 17 rows flagged as duplicates and unticked');

  // ---- 5. visibility enforced for the other adult and the child -----------------------------
  const ids = (list) => list.map((t) => t.id);
  assert.equal((await sam.api(`/budget/transactions?import_id=${uob.import.id}`)).length, 0, 'Sam: no Only-me rows');
  assert.equal((await sam.api(`/budget/transactions?import_id=${dbs.import.id}`)).length, 16, 'Sam: adults rows');
  assert.ok(!(await sam.api('/budget/imports')).some((i) => i.id === uob.import.id), 'Sam: private import not in history');
  await sam.page.goto(`${BASE}/budget/import`);
  await sam.page.getByText('Past imports').waitFor();
  await sam.page.getByText('DBS ••4821').first().waitFor();
  assert.equal(await sam.page.getByText('UOB ••7890').count(), 0, 'Sam does not see the UOB import');
  await sam.page.goto(`${BASE}/budget/transactions?month=2026-10`);
  await sam.page.getByText('Imported · DBS ••4821').first().waitFor();
  assert.equal(await sam.page.getByText('Imported · UOB ••7890').count(), 0);
  const kid = mia.page;
  assert.deepEqual(ids(await mia.api(`/budget/transactions?import_id=${dbs.import.id}`)), [], 'Mia: no adults rows');
  await kid.goto(`${BASE}/budget/transactions?month=2026-10`);
  await kid.getByText('October 2026').first().waitFor();
  await kid.waitForTimeout(600);
  assert.equal(await kid.getByText(/Imported ·/).count(), 0, 'Mia sees no imported rows');
  assert.equal(await kid.getByRole('button', { name: 'Import statement' }).count(), 0, 'no import button for kids');
  assert.equal(await kid.getByText('Insights').count(), 0, 'no insights tab for kids');
  await kid.goto(`${BASE}/budget/import`);
  await kid.waitForURL((u) => u.pathname === '/budget');
  await kid.goto(`${BASE}/budget/insights`);
  await kid.waitForURL((u) => u.pathname === '/budget');
  ok('Only me → invisible to Sam (rows, history); Adults only → invisible to Mia; kids get no entry points');

  // ---- 6. insights from real data ----------------------------------------------------------
  for (const [p, tag] of [[A, 'desktop-light'], [dark.page, 'desktop-dark'], [mob.page, 'mobile-light'], [mobDark.page, 'mobile-dark']]) {
    await p.goto(`${BASE}/budget/insights`);
    await p.getByText('Can we afford our goals?').waitFor();
    await p.getByText('Avg income').waitFor();
    const tile = await p.locator('div', { hasText: /^Avg income/ }).locator('xpath=..').first().innerText();
    assert.match(tile, /\$[1-9]/, 'avg income is a real amount');
    await p.getByText('* this month so far').waitFor();
    await p.getByText("Transfers between your own accounts aren't counted.").waitFor();
    await p.getByText('Last 3 months + this month so far').nth(1).waitFor(); // top merchants say they include this month
    await p.getByText(/•• ?(4821|1357|7890)/).first().waitFor(); // latest balances
    await noHorizontalScroll(p, `insights ${tag}`);
    await p.waitForFunction(() => document.querySelectorAll('.recharts-bar-rectangle path').length >= 4, null, { timeout: 10_000 });
    await shot(p, `10-insights-${tag}`);
    // Full-page captures resize the viewport (restarting the bar animation); also shoot the chart in place.
    await p.getByText('Income vs spending').scrollIntoViewIfNeeded();
    await p.waitForTimeout(1200);
    await shot(p, `10b-insights-chart-${tag}`, false);
  }
  await segment(A, '6 months').click();
  await A.waitForURL('**/budget/insights?months=6');
  ok('insights render real averages, balances, partial month; 3/6/12 window');

  // Round-3 server fields: assert when present, otherwise say what was skipped.
  {
    const ins = await alex.api('/budget/insights?months=3');
    await A.goto(`${BASE}/budget/insights`);
    await A.getByText('Can we afford our goals?').waitFor();
    if (ins.spikes?.some((s) => s.usual_by_now !== undefined)) {
      const s = ins.spikes.find((x) => x.usual_by_now !== undefined);
      await A.getByText(new RegExp(`so far — usually .+ by now \\(\\+${Math.round(s.change_pct)}%\\)`)).first().waitFor();
    } else console.log('    ⚠ skipped: no spikes[].usual_by_now from the server (spike wording not checked against real data)');
    // A % is never printed next to the full-month average.
    assert.equal(await A.getByText(/% above your .* average/).count(), 0, 'no % next to a full-month average');
    if (!('today' in ins)) console.log('    ⚠ skipped: server has no insights.today yet (browser date used for the early-month rule)');
    const bills = await alex.api(`/budget/recurring?month=${new Date().toISOString().slice(0, 7)}`);
    if (bills.some((b) => b.status === 'expected')) {
      await A.goto(`${BASE}/budget/bills`);
      await A.getByText('Expected', { exact: true }).first().waitFor();
      await A.getByText(/Not due yet · around/).first().waitFor();
      await shot(A, '16-bills-expected-desktop-light');
    } else console.log("    ⚠ skipped: no bill with status 'expected' from the server");
  }

  // ---- 7. undo, then the same file is no longer a duplicate ---------------------------------
  await A.goto(`${BASE}/budget/import`);
  await A.getByText('Past imports').waitFor();
  await shot(A, '08-history-desktop-light');
  const row = A.locator('li', { hasText: 'DBS ••4821' });
  await row.getByRole('button', { name: 'Undo import' }).click();
  await A.getByRole('dialog').getByText(/Bills it created stay/).waitFor();
  await shot(A, '09-undo-confirm-desktop-light', false);
  await A.getByRole('dialog').getByRole('button', { name: 'Undo import' }).click();
  await A.getByText('Removed 16 transactions').waitFor();
  await A.locator('li', { hasText: 'DBS ••4821' }).waitFor({ state: 'detached' });
  assert.equal((await alex.api(`/budget/transactions?import_id=${dbs.import.id}`)).length, 0);
  await upload(A, file('dbs.csv', 'text/csv'));
  assert.equal(await A.getByText('Already in Hearth · skipped').count(), 0, 'undone rows are not duplicates');
  await A.getByText('17 of 17 transactions selected').waitFor();
  ok('undo removes the import and its rows; re-uploading it is no longer flagged as duplicate');

  // ---- 8. friendly errors + insecure context -----------------------------------------------
  await A.goto(`${BASE}/budget/import`);
  await A.locator('input[type=file]').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('Date,Thing\n2026-01-01,abc\n') });
  await A.getByText("Hearth can't read this file yet").waitFor();
  await A.getByText(/DBS digibank or UOB Personal Internet Banking/).waitFor();
  await A.locator('input[type=file]').setInputFiles({ name: 'huge.pdf', mimeType: PDF, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await A.getByText('That file is too large').waitFor();
  await A.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  await A.getByText("Hearth can't read this file yet").waitFor();
  await shot(A, '14-error-desktop-light', false);
  ok('unsupported file / too large / wrong type explained');

  {
    const lan = await open('alex@hearth.test', { base: INSECURE, viewport: { width: 390, height: 844 } });
    const sent = [];
    lan.page.on('request', (r) => { if (r.url().includes('/imports/preview')) sent.push(r.url()); });
    await lan.page.goto(`${INSECURE}/budget/import`);
    assert.equal(await lan.page.evaluate(() => window.isSecureContext), false);
    await lan.page.getByText("You're not on a secure (https) connection").waitFor();
    await lan.page.locator('input[type=file]').setInputFiles(file('uob-protected.pdf', PDF));
    await lan.page.waitForTimeout(500);
    assert.equal(sent.length, 0, 'nothing sent before "Upload anyway"');
    await shot(lan.page, '15-insecure-mobile-light');
    await lan.page.getByRole('button', { name: 'Upload anyway' }).click();
    await lan.page.getByLabel('Statement password').waitFor();
    assert.equal(sent.length, 1, 'sent after confirming');
    ok('insecure origin: warning shown, upload waits for an explicit confirm');
    await lan.ctx.close();
  }

  // ---- 9. Wall activity links to the import filter -----------------------------------------
  const acts = await alex.api('/activity?module=budget');
  const posbAct = acts.find((a) => a.link === `/budget/transactions?import=${posb.import.id}`);
  assert.ok(posbAct, 'activity links to the import filter');
  await sam.page.goto(`${BASE}${posbAct.link}`);
  await sam.page.getByText('Imported from POSB ••1357').waitFor();
  ok('Wall activity link opens History filtered to that import');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All import checks passed.');
} catch (e) {
  console.error(e);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
