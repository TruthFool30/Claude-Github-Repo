// Budget module browser smoke test.
//   BASE=http://localhost:4207 node scripts/e2e-budget.mjs
// Needs a seeded instance (npm run seed) and a built client. Uses two browser contexts
// (Alex + Sam) to check live updates, plus Mia for the child view.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run Node and the browser in the demo family's time zone (seed.js DEMO_TZ), so "today" matches the server.
process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';

const BASE = process.env.BASE || 'http://localhost:4207';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

async function login(email, { viewport = { width: 1280, height: 800 }, ui = false } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (404|403)/.test(m.text())) errors.push(`${email}: ${m.text()}`);
  });
  if (ui) {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', 'hearth123');
    await page.click('button[type=submit]');
    await page.waitForURL('**/home');
  } else {
    const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
    assert.equal(r.status(), 200, `login ${email}`);
  }
  return { ctx, page };
}

/**
 * No element may stick out past the viewport's right edge (body clips overflow-x, so the page
 * width alone would hide it). Content inside an intentional horizontal scroller is ignored.
 */
const noHorizontalScroll = async (page, where) => {
  await page.waitForTimeout(600);
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
  assert.deepEqual(bad, [], `${where}: elements overflow the ${await page.evaluate(() => window.innerWidth)}px viewport`);
};

try {
  console.log(`Budget e2e against ${BASE}`);
  const alex = await login('alex@hearth.test', { ui: true });
  const sam = await login('sam@hearth.test');
  const A = alex.page;
  const S = sam.page;

  // ---- overview -----------------------------------------------------------------------------
  await A.goto(`${BASE}/budget`);
  await A.getByText('Where the money went').waitFor();
  await A.getByText('Monthly limits').waitFor();
  await A.getByText('Last 6 months').waitFor();
  assert.ok(await A.locator('.recharts-bar-rectangle').count() >= 10, 'trend bars rendered');
  await noHorizontalScroll(A, 'overview (1280)');
  // Donut + over-budget banner need a month with real spending. Early in a month the current one
  // can legitimately be sparse, so use whichever of this / last month the summary API says has it.
  {
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const now = new Date();
    const thisMonth = ym(now);
    const lastMonth = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const rich = async (month) => {
      const s = await (await A.request.get(`${BASE}/api/budget/summary?month=${month}`)).json();
      const spent = s.categories.filter((c) => c.kind === 'expense' && c.total > 0);
      const over = spent.filter((c) => c.monthly_limit && c.total > c.monthly_limit);
      return spent.length >= 3 && over.length >= 1;
    };
    const month = (await rich(thisMonth)) ? thisMonth : lastMonth;
    assert.ok(month === thisMonth || (await rich(lastMonth)), 'seed has a month with ≥3 spending categories and one over its limit');
    if (month !== thisMonth) {
      await A.goto(`${BASE}/budget?month=${month}`);
      await A.getByText('Where the money went').waitFor();
    }
    await A.locator('.recharts-pie-sector').nth(2).waitFor();
    assert.ok(await A.locator('.recharts-pie-sector').count() >= 3, `donut rendered (${month})`);
    await A.getByRole('alert').filter({ hasText: /over (its|budget)/ }).first().waitFor();
    if (month !== thisMonth) {
      await A.goto(`${BASE}/budget`);
      await A.getByText('Where the money went').waitFor();
    }
  }
  ok('overview shows totals, donut, limits and 6-month trend');

  // Month navigation
  const current = await A.locator('[aria-live=polite]').first().innerText();
  await A.getByRole('button', { name: 'Previous month' }).first().click();
  await A.waitForURL(/month=\d{4}-\d{2}/);
  await A.waitForFunction((c) => document.querySelector('[aria-live=polite]')?.textContent !== c, current);
  await A.getByRole('button', { name: 'Today' }).first().click();
  await A.waitForFunction((c) => document.querySelector('[aria-live=polite]')?.textContent === c, current);
  ok('month navigation (previous / back to today)');

  // ---- transactions + live updates -----------------------------------------------------------
  await A.goto(`${BASE}/budget/transactions`);
  await S.goto(`${BASE}/budget/transactions`);
  await A.waitForSelector('section ul li button');
  await S.waitForSelector('section ul li button');

  // validation
  await A.getByRole('button', { name: 'Add transaction' }).first().click();
  const dlg = A.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByText('Enter an amount greater than zero').waitFor();
  ok('form validation shows an error for a missing amount');

  const label = `E2E pizza ${Date.now() % 100000}`;
  await dlg.getByLabel('Amount').fill('23,45'); // decimal comma → 23.45
  await dlg.locator('input[name=description]').fill(label);
  await dlg.getByRole('radio', { name: 'Dining' }).click();
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await A.getByText('Expense added').waitFor();
  await A.getByRole('button', { name: new RegExp(label) }).waitFor();
  ok('Alex adds an expense');
  await S.getByRole('button', { name: new RegExp(label) }).waitFor({ timeout: 8000 });
  ok('Sam sees the new expense live (no reload)');

  // detail + edit
  await A.getByRole('button', { name: new RegExp(label) }).click();
  await A.getByRole('dialog').getByText('$23.45').waitFor();
  assert.match(A.url(), /tx=\d+/);
  await A.getByRole('dialog').getByRole('button', { name: 'Edit' }).click();
  const edit = A.getByRole('dialog');
  await edit.getByLabel('Amount').fill('30');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await A.getByText('Transaction updated').waitFor();
  await S.getByRole('button', { name: new RegExp(`${label}.*\\$30\\.00`) }).waitFor({ timeout: 8000 });
  ok('edit amount → Sam sees $30.00 live');

  // search filter
  await A.getByLabel('Search transactions').fill(label);
  await A.getByText(`Results for “${label}”`).waitFor();
  assert.equal(await A.locator('section ul li button').count(), 1);
  await A.getByLabel('Clear search').click();
  ok('search filters the list');
  await A.goto(`${BASE}/budget/transactions?q=Costco`);
  assert.equal(await A.getByLabel('Search transactions').inputValue(), 'Costco');
  await A.getByText('Results for “Costco”').waitFor();
  ok('?q= deep link prefills the search');
  await A.goto(`${BASE}/budget/transactions`);

  // delete + undo + delete
  await A.getByRole('button', { name: new RegExp(label) }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await A.getByText('Transaction deleted').waitFor();
  await A.getByRole('button', { name: new RegExp(label) }).waitFor({ state: 'detached' });
  await A.getByRole('button', { name: 'Undo' }).click();
  await A.getByRole('button', { name: new RegExp(label) }).waitFor();
  ok('delete with Undo restores the transaction');
  await A.getByRole('button', { name: new RegExp(label) }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await S.getByRole('button', { name: new RegExp(label) }).waitFor({ state: 'detached', timeout: 8000 });
  ok('delete propagates live to Sam');

  // ---- bills ---------------------------------------------------------------------------------
  await A.goto(`${BASE}/budget/bills`);
  await S.goto(`${BASE}/budget/bills`);
  const payBtn = A.getByRole('button', { name: /^Mark .+ paid$/ }).first();
  await payBtn.waitFor();
  const billName = (await payBtn.getAttribute('aria-label')).replace(/^Mark /, '').replace(/ paid$/, '');
  await S.getByRole('button', { name: `Mark ${billName} paid` }).waitFor();
  await payBtn.click();
  await A.getByText(`${billName} marked paid`).waitFor();
  await S.getByRole('button', { name: `Mark ${billName} paid` }).waitFor({ state: 'detached', timeout: 8000 });
  ok(`mark "${billName}" paid → Sam's list updates live`);
  // undo via menu
  await A.getByRole('button', { name: `Actions for ${billName}` }).click();
  await A.getByRole('menuitem', { name: 'Undo payment' }).click();
  await A.getByRole('button', { name: `Mark ${billName} paid` }).waitFor();
  ok('undo payment returns the bill to due');

  // ---- goals ---------------------------------------------------------------------------------
  await A.goto(`${BASE}/budget/goals`);
  await S.goto(`${BASE}/budget/goals`);
  const bikeCard = S.getByRole('button', { name: 'Open goal New bike' });
  await bikeCard.waitFor();
  const before = await S.locator('div', { has: bikeCard }).last().innerText();
  await A.getByRole('button', { name: 'Open goal New bike' }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'Add money' }).click();
  const contrib = A.getByRole('dialog', { name: 'Add to New bike' });
  await contrib.getByLabel('Amount').fill('5');
  await contrib.getByRole('button', { name: 'Add money' }).click();
  await A.getByText(/\$5\.00 added to New bike|Goal reached/).waitFor();
  await S.waitForFunction(
    (prev) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Open goal New bike');
      return b && b.parentElement && b.parentElement.innerText !== prev;
    },
    before,
    { timeout: 8000 },
  );
  ok('add money to a goal → Sam sees the new total live');

  // ---- categories ----------------------------------------------------------------------------
  await A.goto(`${BASE}/budget`);
  await A.getByRole('button', { name: 'Budget options' }).click();
  await A.getByRole('menuitem', { name: 'Categories & limits' }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'New category' }).click();
  const catName = `E2E Pets ${Date.now() % 1000}`;
  const catDlg = A.getByRole('dialog');
  await catDlg.getByLabel('Name').fill(catName);
  await catDlg.getByRole('radio', { name: 'dog' }).click();
  await catDlg.locator('input[name=limit]').fill('75');
  await catDlg.getByRole('button', { name: 'Add', exact: true }).click();
  await A.getByText('Category added').waitFor();
  await A.getByRole('dialog').getByText(catName).waitFor();
  ok('create a category with a monthly limit');
  await A.getByRole('dialog').getByRole('button', { name: new RegExp(catName) }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await A.getByRole('alertdialog').or(A.getByRole('dialog').last()).getByRole('button', { name: 'Delete category' }).click();
  await A.getByText('Category deleted').waitFor();
  ok('delete the category');

  // ---- mobile: every tab fits 390px and the section switcher shows all four -------------------
  const alexMobile = await login('alex@hearth.test', { viewport: { width: 390, height: 844 } });
  const M = alexMobile.page;
  for (const [path, marker, section] of [
    ['/budget', 'Where the money went', 'Overview'],
    ['/budget/transactions', 'Search transactions', 'History'],
    ['/budget/bills', 'Bills in', 'Bills'],
    ['/budget/goals', 'Savings goals', 'Goals'],
  ]) {
    await M.goto(BASE + path);
    await (marker === 'Search transactions' ? M.getByLabel(marker) : M.getByText(marker).first()).waitFor();
    const nav = M.getByRole('radiogroup', { name: 'Budget sections' });
    for (const label of ['Overview', 'History', 'Bills', 'Goals']) assert.ok(await nav.getByRole('radio', { name: new RegExp(`^${label}`) }).isVisible(), `${label} visible on ${path}`);
    assert.equal(await nav.getByRole('radio', { name: new RegExp(`^${section}`) }).getAttribute('aria-checked'), 'true', `${section} active on ${path}`);
    await noHorizontalScroll(M, `mobile ${path}`);
  }
  await M.getByRole('button', { name: 'New goal' }).last().click(); // Goals FAB
  await M.getByRole('dialog', { name: 'New savings goal' }).waitFor();
  await alexMobile.ctx.close();
  ok('mobile (390px): all four tabs fit without overflow, active section visible, Goals FAB = New goal');

  // ---- child view + mobile -------------------------------------------------------------------
  const mia = await login('mia@hearth.test', { viewport: { width: 390, height: 844 } });
  await mia.page.goto(`${BASE}/budget/bills`);
  await mia.page.getByText('Needs attention').or(mia.page.getByText('Paid & skipped')).first().waitFor();
  assert.equal(await mia.page.getByRole('button', { name: /^Mark .+ paid$/ }).count(), 0, 'kids cannot mark bills paid');
  await noHorizontalScroll(mia.page, 'mobile bills');
  await mia.page.goto(`${BASE}/budget`);
  await mia.page.getByText('Where the money went').waitFor();
  await noHorizontalScroll(mia.page, 'mobile overview');
  await mia.page.getByRole('button', { name: 'Add transaction' }).last().click(); // FAB
  await mia.page.getByRole('dialog').getByText('Add expense').waitFor();
  assert.equal(await mia.page.getByRole('dialog').getByRole('group', { name: 'Paid by' }).count(), 0, 'kids record their own spending');
  assert.equal(await mia.page.getByRole('dialog').getByRole('radio', { name: 'Income' }).count(), 0, 'kids record expenses only');
  ok('child (Mia) on mobile: read-only bills, FAB opens the add sheet, no overflow');

  // Wall activity links into the module
  const act = await A.request.get(`${BASE}/api/activity?module=budget`);
  const rows = await act.json();
  assert.ok(rows.some((r) => r.summary.includes(label) && r.link.startsWith('/budget/transactions')), 'activity logged');
  ok('wall activity was logged for the new expense');

  assert.deepEqual(errors, [], 'no console errors');
  ok('no console errors');
  console.log(`\nAll ${step} budget checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error('Console errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
