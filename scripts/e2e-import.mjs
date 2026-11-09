// Statement import + insights browser test (client side).
//   BASE=http://localhost:4391 node scripts/e2e-import.mjs        (SHOTS=/some/dir to save screenshots)
// Needs a seeded instance (npm run seed) and a built client.
//
// MOCKED ENDPOINTS: until the server implements the import contract, this script answers
// /api/budget/imports* and /api/budget/insights with contract-shaped fixtures via page.route, and
// decorates real /api/budget/transactions responses with the new visibility/import_id/balance
// fields. Everything else (auth, categories, bills, goals, transactions) is the real server.
// Set MOCK=0 once the server ships the endpoints to run the same flow against it (fixtures off).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

process.env.TZ ||= process.env.HEARTH_DEMO_TZ || 'America/Chicago';
const BASE = process.env.BASE || 'http://localhost:4391';
const SHOTS = process.env.SHOTS || '';
const MOCK = process.env.MOCK !== '0';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const port = new URL(BASE).port;
// A non-localhost name for the same server, so the page is NOT a secure context (http + not loopback).
const INSECURE = `http://hearth-lan.test:${port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
  args: ['--host-resolver-rules=MAP hearth-lan.test 127.0.0.1'],
});
const errors = [];
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

const pad = (n) => String(n).padStart(2, '0');
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const now = new Date();
const thisMonth = ym(now);
const prev = (n) => ym(new Date(now.getFullYear(), now.getMonth() - n, 1));

// ---- fixtures (contract-shaped) ---------------------------------------------------------------

function previewFixture(cat) {
  const m = prev(1);
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate();
  const rows = [];
  const add = (day, description, amount, kind, category, source, extra = {}) =>
    rows.push({
      row_id: `r${rows.length + 1}`, date: `${m}-${pad(day)}`, description, amount, kind, balance: null,
      category_id: category ? cat[category] : null, category_source: category ? source : 'none', duplicate: false, recurring_group: null, ...extra,
    });
  add(1, 'SALARY GIRO ACME PTE LTD', 6200, 'income', 'Salary', 'rule');
  add(2, 'SP GROUP UTILITIES ••4417', 142.35, 'expense', 'Utilities', 'learned', { recurring_group: 'g-sp' });
  add(3, 'SINGTEL MOBILE', 48, 'expense', null, 'none', { recurring_group: 'g-singtel' });
  add(3, 'NETFLIX.COM', 19.98, 'expense', 'Entertainment', 'rule', { recurring_group: 'g-netflix', duplicate: true });
  for (let i = 0; i < 64; i++) {
    const day = 4 + (i % (last - 4));
    const shops = [
      ['NTUC FAIRPRICE', 'Groceries', 'learned'], ['GRAB *TRIP', 'Transport', 'rule'], ['KOPITIAM', null, 'none'],
      ['TOAST BOX', 'Dining', 'rule'], ['GUARDIAN HEALTH', null, 'none'], ['SHOPEE SG', 'Shopping', 'learned'],
    ];
    const [d, c, s] = shops[i % shops.length];
    add(day, `${d} ${1000 + i}`, Math.round((6 + (i * 7.31) % 80) * 100) / 100, 'expense', c, s);
  }
  add(last, 'INTEREST EARNED', 1.23, 'income', null, 'none');
  rows.sort((a, b) => a.date.localeCompare(b.date));
  let bal = 3120.5;
  for (const r of rows) {
    bal += r.kind === 'income' ? r.amount : -r.amount;
    r.balance = Math.round(bal * 100) / 100;
  }
  const income = rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount, 0);
  const spending = rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount, 0);
  return {
    token: 'tok_test_123', expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), bank: 'dbs', format: 'pdf',
    account: { label: 'DBS ••4821', last4: '4821' }, currency: 'SGD',
    period: { from: `${m}-01`, to: `${m}-${pad(last)}` }, opening_balance: 3120.5, closing_balance: rows.at(-1).balance,
    rows,
    recurring: [
      { group: 'g-sp', merchant: 'SP Group', description: 'SP GROUP UTILITIES ••4417', amount: 142.35, kind: 'expense', day_of_month: 2, months_seen: 3, category_id: cat.Utilities, existing_bill_id: null },
      { group: 'g-singtel', merchant: 'Singtel', description: 'SINGTEL MOBILE', amount: 48, kind: 'expense', day_of_month: 3, months_seen: 4, category_id: null, existing_bill_id: null },
      { group: 'g-netflix', merchant: 'Netflix', description: 'NETFLIX.COM', amount: 19.98, kind: 'expense', day_of_month: 3, months_seen: 6, category_id: cat.Entertainment, existing_bill_id: 2 },
    ],
    summary: { count: rows.length, income: Math.round(income * 100) / 100, spending: Math.round(spending * 100) / 100, duplicates: 1 },
    warnings: ['2 lines could not be read and were left out.'],
  };
}

const importOut = (over = {}) => ({
  id: 7, bank: 'dbs', account_label: 'DBS ••4821', period_from: `${prev(1)}-01`, period_to: `${prev(1)}-28`, row_count: 68,
  visibility: 'adults', created_by: 1, created_at: new Date(Date.now() - 3600_000).toISOString(), total_income: 6201.23, total_spending: 2895.4, ...over,
});

function insightsFixture(months, cat) {
  const list = [];
  for (let i = months; i >= 1; i--) list.push({ month: prev(i), income: 6200 + (i % 3) * 150, spending: 4300 + (i % 4) * 380, surplus: 0 });
  list.push({ month: thisMonth, income: 0, spending: 1240.5, surplus: 0, partial: true });
  for (const m of list) m.surplus = Math.round((m.income - m.spending) * 100) / 100;
  const full = list.slice(0, -1);
  const avg = (k) => Math.round((full.reduce((s, m) => s + m[k], 0) / full.length) * 100) / 100;
  return {
    months: list, avg_income: avg('income'), avg_spending: avg('spending'), avg_surplus: avg('surplus'),
    balances: [
      { account_label: 'DBS ••4821', balance: 6427.33, as_of: `${prev(1)}-28` },
      { account_label: 'UOB ••0932', balance: 15210.08, as_of: `${prev(1)}-30` },
    ],
    categories: [
      { category_id: cat.Groceries, name: 'Groceries', icon: 'shopping-cart', color: '#30A46C', avg: 820.4, this_month: 410.2, change_pct: -50 },
      { category_id: cat.Dining, name: 'Dining', icon: 'utensils', color: '#F76B15', avg: 380, this_month: 620.75, change_pct: 63.3 },
      { category_id: cat.Transport, name: 'Transport', icon: 'car', color: '#0090FF', avg: 210, this_month: 96, change_pct: -54.3 },
      { category_id: null, name: 'Uncategorized', icon: 'circle-dashed', color: '#8D90A0', avg: 120, this_month: 113.55, change_pct: null },
    ],
    merchants: [
      { merchant: 'NTUC FairPrice', total: 2461.2, count: 31 }, { merchant: 'Grab', total: 630, count: 44 },
      { merchant: 'Shopee', total: 512.9, count: 9 }, { merchant: 'Toast Box', total: 288.6, count: 27 },
    ],
    spikes: [{ category_id: cat.Dining, name: 'Dining', this_month: 620.75, avg: 380, change_pct: 63.3 }],
    recurring: { total_monthly: 1650.33, bills: [{ id: 1, description: 'Rent', amount: 1450 }, { id: 2, description: 'Netflix', amount: 19.98 }, { id: 3, description: 'SP Group', amount: 142.35 }] },
    goals: {
      needed_monthly: 2350, surplus: avg('surplus'), status: 'short', shortfall: Math.round((2350 - avg('surplus')) * 100) / 100,
      items: [
        { id: 1, name: 'Japan trip', emoji: '🗾', monthly: 1250, target_date: `${now.getFullYear() + 1}-06-01`, auto_monthly: true },
        { id: 2, name: 'Emergency fund', emoji: '🛟', monthly: 1100, target_date: `${now.getFullYear() + 1}-12-01`, auto_monthly: false },
      ],
      undated: 2,
      suggestions: ['Trimming Dining back to its average would free about $240 a month.', 'Moving the Japan trip to September makes it fit.'],
    },
  };
}

const emptyInsights = (months) => ({
  months: Array.from({ length: months + 1 }, (_, i) => ({ month: i === months ? thisMonth : prev(months - i), income: 0, spending: 0, surplus: 0, partial: i === months })),
  avg_income: 0, avg_spending: 0, avg_surplus: 0, balances: [], categories: [], merchants: [], spikes: [],
  recurring: { total_monthly: 0, bills: [] },
  goals: { needed_monthly: 0, surplus: 0, status: 'no_data', shortfall: 0, items: [], undated: 0, suggestions: [] },
});

// ---- mock wiring ------------------------------------------------------------------------------

/** Installs the fixtures on a page; returns the recorded requests. */
async function mock(page, cat, { emptyInsightsMode = false } = {}) {
  const rec = { previews: [], commits: [], deletes: [], insights: [] };
  if (!MOCK) return rec;
  let imports = [importOut({ id: 3, bank: 'uob', account_label: 'UOB ••0932', visibility: 'private', row_count: 41, period_from: `${prev(2)}-01`, period_to: `${prev(2)}-30` })];
  await page.route('**/api/budget/imports/preview', async (route) => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? '';
    const pw = /name="password"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? null;
    const name = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
    rec.previews.push({ pw, name });
    const json = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\.csv$/.test(name)) return json(400, { error: 'Not a DBS or UOB statement', code: 'UNSUPPORTED' });
    if (/empty/.test(name)) return json(400, { error: 'No transactions', code: 'EMPTY' });
    if (pw === null) return json(400, { error: 'Password required', code: 'PASSWORD_REQUIRED' });
    if (pw !== 'S1234567A') return json(400, { error: 'Wrong password', code: 'BAD_PASSWORD' });
    return json(200, previewFixture(cat));
  });
  await page.route('**/api/budget/imports/*/commit', async (route) => {
    const b = route.request().postDataJSON();
    rec.commits.push(b);
    const created = b.rows.filter((r) => r.include).length;
    const imp = importOut({ id: 7, visibility: b.visibility, row_count: created });
    imports = [imp, ...imports];
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ import: imp, created, skipped_duplicates: b.rows.length - created, bills_created: b.bills.length }) });
  });
  await page.route(/\/api\/budget\/imports(\/\d+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === 'DELETE') {
      const id = Number(req.url().split('/').pop());
      rec.deletes.push(id);
      const gone = imports.find((i) => i.id === id);
      imports = imports.filter((i) => i.id !== id);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, removed: gone?.row_count ?? 0 }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(imports) });
  });
  await page.route('**/api/budget/insights*', async (route) => {
    const months = Number(new URL(route.request().url()).searchParams.get('months')) || 3;
    rec.insights.push(months);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyInsightsMode ? emptyInsights(months) : insightsFixture(months, cat)) });
  });
  // Decorate real transaction responses with the contract's new fields (every 3rd row "imported").
  const decorate = (t) => (t && typeof t === 'object' && 'id' in t
    ? { ...t, visibility: t.visibility ?? (t.id % 3 === 0 ? 'adults' : t.id % 7 === 0 ? 'private' : 'family'), import_id: t.import_id ?? (t.id % 3 === 0 ? 3 : null), balance: t.balance ?? (t.id % 3 === 0 ? 4210.55 : null) }
    : t);
  await page.route(/\/api\/budget\/transactions(\/\d+)?(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const data = await res.json();
    const out = Array.isArray(data) ? data.map(decorate) : data?.items ? { ...data, items: data.items.map(decorate) } : decorate(data);
    await route.fulfill({ response: res, body: JSON.stringify(out) });
  });
  return rec;
}

async function open(email, { viewport = { width: 1280, height: 860 }, theme = 'light', base = BASE } = {}) {
  const mobile = viewport.width < 600;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
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
  return { ctx, page };
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

const PDF = { name: 'dbs-statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% fake statement for the UI test\n') };

/** The full wizard at one viewport/theme. Assertions run every time; screenshots tagged by variant. */
async function wizard(cat, viewport, theme, tag) {
  const { ctx, page } = await open('alex@hearth.test', { viewport, theme });
  const rec = await mock(page, cat);
  const mobile = viewport.width < 600;

  // Entry point from the Transactions header.
  await page.goto(`${BASE}/budget/transactions`);
  await page.getByRole('button', { name: 'Import statement' }).first().click();
  await page.waitForURL('**/budget/import');
  await page.getByText('Drop a bank statement here').waitFor();
  await page.getByText('never stored').waitFor();
  assert.equal(await page.getByText("You're not on a secure").count(), 0, 'no insecure warning on localhost');
  await page.getByText('UOB ••0932').waitFor(); // history
  await shot(page, `01-upload-${tag}`);

  // Password-protected PDF: required → wrong → right.
  await page.locator('input[type=file]').setInputFiles(PDF);
  const pw = page.getByLabel('Statement password');
  await pw.waitFor();
  await page.getByText('often with your NRIC or date of birth').waitFor();
  assert.equal(await pw.evaluate((el) => el === document.activeElement), true, 'password field focused');
  await pw.fill('wrong');
  await page.getByRole('button', { name: 'Unlock and read' }).click();
  await page.getByText("That password didn't open the file").waitFor();
  assert.equal(await pw.inputValue(), '', 'wrong password cleared');
  await shot(page, `02-password-${tag}`, false);
  await pw.fill('S1234567A');
  await pw.press('Enter');
  await page.getByText('Step 2 of 4').waitFor();
  if (MOCK) assert.deepEqual(rec.previews.map((p) => p.pw), [null, 'wrong', 'S1234567A']);

  // Review.
  await page.getByText('DBS ••4821').first().waitFor();
  await page.getByText('2 lines could not be read').waitFor();
  await page.getByText('Already in Hearth · skipped').waitFor();
  const netflix = page.getByRole('checkbox', { name: 'Import NETFLIX.COM' });
  assert.equal(await netflix.isChecked(), false, 'duplicate pre-excluded');
  assert.ok(await page.getByText('Learned', { exact: true }).count() > 0, 'learned hint');
  assert.ok(await page.getByText('Rule', { exact: true }).count() > 0, 'rule hint');
  await page.getByText('of 69 transactions selected').waitFor();
  await page.getByText('68 of 69').waitFor();
  assert.ok(await page.getByRole('button', { name: /Show \d+ more/ }).count() === 1, 'paginated');
  await noHorizontalScroll(page, `review ${tag}`);
  await shot(page, `03-review-${tag}`, !mobile);
  if (mobile) await shot(page, `03-review-full-${tag}`);

  // Uncategorised filter + bulk "set for all from this merchant".
  await page.getByRole('radio', { name: /Uncategorised \d+/ }).or(page.getByRole('button', { name: /Uncategorised \d+/ })).first().click();
  const kopi = page.getByRole('combobox', { name: /Category for KOPITIAM/ }).first();
  await kopi.selectOption({ label: 'Dining' });
  await page.getByText(/Use Dining for 10 other transactions from this merchant/).waitFor();
  await shot(page, `04-bulk-${tag}`, false);
  await page.getByRole('button', { name: 'Set for all' }).click();
  await page.getByText('Updated 11 transactions').waitFor();
  assert.equal(await page.getByRole('combobox', { name: /Category for KOPITIAM/ }).count(), 11, 'categorised rows stay listed under the filter');
  for (const sel of await page.getByRole('combobox', { name: /Category for KOPITIAM/ }).all()) assert.equal(await sel.inputValue(), String(cat.Dining));
  await page.getByRole('radio', { name: /^All \d+/ }).or(page.getByRole('button', { name: /^All \d+/ })).first().click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Recurring.
  await page.getByText('Step 3 of 4').waitFor();
  await page.getByText('Already one of your bills').waitFor();
  const sw = (n) => page.getByRole('switch', { name: `Create a monthly bill for ${n}` });
  assert.equal(await sw('SP Group').getAttribute('aria-checked'), 'true');
  assert.equal(await sw('Netflix').getAttribute('aria-checked'), 'false', 'existing bill pre-off');
  await shot(page, `05-recurring-${tag}`);
  await sw('Singtel').click(); // off
  await sw('Singtel').click(); // on again
  const singtelCard = page.locator('div.flex.flex-col.gap-3', { has: sw('Singtel') }).first();
  await singtelCard.getByLabel('Amount').fill('52.50');
  await singtelCard.getByLabel('Day of month').fill('5');
  await singtelCard.getByLabel('Category').selectOption({ label: 'Utilities' });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Who can see it.
  await page.getByText('Step 4 of 4').waitFor();
  assert.equal(await page.getByRole('radio', { name: /Adults only/ }).getAttribute('aria-checked'), 'true', 'adults default');
  assert.equal(await page.getByRole('radio', { name: /Everyone/ }).count(), 0, 'no Everyone option for imports');
  await shot(page, `06-visibility-${tag}`);
  await page.getByRole('radio', { name: /Only me/ }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByText('Imported 68 transactions').waitFor();
  if (MOCK) {
    const c = rec.commits[0];
    assert.equal(c.visibility, 'private');
    assert.equal(c.rows.length, 69);
    assert.deepEqual(Object.keys(c.rows[0]).sort(), ['category_id', 'include', 'row_id']);
    assert.equal(c.rows.find((r) => r.row_id === previewFixture(cat).rows.find((x) => x.duplicate).row_id).include, false);
    assert.deepEqual(c.bills.map((b) => b.group).sort(), ['g-singtel', 'g-sp']);
    const s = c.bills.find((b) => b.group === 'g-singtel');
    assert.equal(s.amount, 52.5);
    assert.equal(s.day_of_month, 5);
    assert.equal(s.category_id, cat.Utilities);
  }
  await page.getByText('visible to only you').waitFor();
  await shot(page, `07-done-${tag}`);

  // History + undo (back on step 1).
  await page.getByRole('button', { name: 'Import another' }).click();
  await page.getByText('Past imports').waitFor();
  await page.getByText('DBS ••4821').first().waitFor();
  await shot(page, `08-history-${tag}`);
  await page.getByRole('button', { name: 'Undo import' }).first().click();
  await page.getByRole('dialog').getByText(/Bills it created stay/).waitFor();
  await shot(page, `09-undo-confirm-${tag}`, false);
  await page.getByRole('dialog').getByRole('button', { name: 'Undo import' }).click();
  await page.getByText(/Removed 68 transactions/).waitFor();
  if (MOCK) assert.deepEqual(rec.deletes, [7]);

  // Insights.
  await page.goto(`${BASE}/budget/insights`);
  await page.getByText('Can we afford our goals?').waitFor();
  await page.getByText(/Short by/).waitFor();
  await page.getByText('Japan trip', { exact: true }).waitFor();
  await page.getByText('2 goals have no target date').waitFor();
  await page.getByText(/63% above your/).waitFor();
  await page.getByText('* this month so far').waitFor();
  await page.getByText('NTUC FairPrice').waitFor();
  await noHorizontalScroll(page, `insights ${tag}`);
  await page.waitForFunction(() => document.querySelectorAll('.recharts-bar-rectangle path').length >= 7, null, { timeout: 10000 });
  await page.waitForTimeout(1200); // let the bars finish animating
  await shot(page, `10-insights-${tag}`);
  // Full-page captures resize the viewport, which restarts the bar animation; also shoot the chart in place.
  await page.getByText('Income vs spending').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shot(page, `10b-insights-chart-${tag}`, false);
  await page.getByRole('radio', { name: '6 months' }).or(page.getByRole('button', { name: '6 months' })).first().click();
  await page.waitForURL('**/budget/insights?months=6');
  await page.getByText('last 6 full months').waitFor();
  if (MOCK) assert.ok(rec.insights.includes(6), 'months=6 requested');

  // Transactions with badges (decorated rows) + detail sheet.
  await page.goto(`${BASE}/budget/transactions`);
  await page.getByText(/Imported · UOB ••0932/).first().waitFor();
  await shot(page, `11-transactions-${tag}`, !mobile);
  const importedRow = page.getByRole('button', { name: /imported from UOB ••0932/ }).first();
  await importedRow.click();
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Imported · UOB ••0932').waitFor();
  await dlg.getByText('Balance after').waitFor();
  await shot(page, `12-detail-${tag}`, false);
  await dlg.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('radiogroup', { name: 'Who can see this transaction' }).waitFor();
  await shot(page, `13-edit-visibility-${tag}`, false);
  await ctx.close();
}

try {
  console.log(`Import e2e against ${BASE}${MOCK ? ' (import/insights endpoints mocked)' : ''}`);
  const probe = await open('alex@hearth.test');
  const cats = await (await probe.page.request.get(`${BASE}/api/budget/categories`)).json();
  const cat = Object.fromEntries(cats.map((c) => [c.name, c.id]));
  await probe.ctx.close();

  await wizard(cat, { width: 1280, height: 860 }, 'light', 'desktop-light');
  ok('desktop light: upload → password → review → bulk → recurring → visibility → commit → undo → insights → badges');
  await wizard(cat, { width: 1280, height: 860 }, 'dark', 'desktop-dark');
  ok('desktop dark: same flow');
  await wizard(cat, { width: 390, height: 844 }, 'light', 'mobile-light');
  ok('mobile light: same flow');
  await wizard(cat, { width: 390, height: 844 }, 'dark', 'mobile-dark');
  ok('mobile dark: same flow');

  // Friendly errors.
  {
    const { ctx, page } = await open('alex@hearth.test');
    await mock(page, cat);
    await page.goto(`${BASE}/budget/import`);
    await page.locator('input[type=file]').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n') });
    await page.getByText("Hearth can't read this file yet").waitFor();
    await page.getByText(/DBS digibank or UOB Personal Internet Banking/).waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await page.getByText('No transactions found').waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await page.getByText('That file is too large').waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('x') });
    await page.getByText("Hearth can't read this file yet").waitFor();
    await shot(page, '14-error-desktop-light', false);
    ok('UNSUPPORTED / EMPTY / TOO_LARGE (client-side 10 MB) / wrong type explained');
    await ctx.close();
  }

  // Not a secure context → warning + explicit "Upload anyway".
  {
    const { ctx, page } = await open('alex@hearth.test', { base: INSECURE, viewport: { width: 390, height: 844 } });
    const rec = await mock(page, cat);
    await page.goto(`${INSECURE}/budget/import`);
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    await page.getByText("You're not on a secure (https) connection").waitFor();
    await page.locator('input[type=file]').setInputFiles(PDF);
    await page.waitForTimeout(400);
    assert.equal(rec.previews.length, 0, 'nothing sent before "Upload anyway"');
    await shot(page, '15-insecure-mobile-light');
    await page.getByRole('button', { name: 'Upload anyway' }).click();
    await page.getByLabel('Statement password').waitFor();
    if (MOCK) assert.equal(rec.previews.length, 1, 'sent after confirming');
    ok('insecure origin: warning shown, upload waits for explicit confirm');
    await ctx.close();
  }

  // Empty insights.
  {
    const { ctx, page } = await open('alex@hearth.test', { viewport: { width: 390, height: 844 } });
    await mock(page, cat, { emptyInsightsMode: true });
    await page.goto(`${BASE}/budget/insights`);
    await page.getByText('Import a statement or add transactions to see insights').waitFor();
    await shot(page, '16-insights-empty-mobile-light');
    ok('insights empty state');
    await ctx.close();
  }

  // Children: no entry points, routes redirect.
  {
    const { ctx, page } = await open('mia@hearth.test');
    await mock(page, cat);
    await page.goto(`${BASE}/budget/transactions`);
    await page.getByRole('tab', { name: /History/ }).or(page.getByText('History')).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Import statement' }).count(), 0, 'no import button for kids');
    assert.equal(await page.getByText('Insights').count(), 0, 'no insights tab for kids');
    await page.goto(`${BASE}/budget/import`);
    await page.waitForURL((u) => u.pathname === '/budget');
    await page.goto(`${BASE}/budget/insights`);
    await page.waitForURL((u) => u.pathname === '/budget');
    ok('child: import + insights hidden and redirected');
    await ctx.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All import checks passed.');
} catch (e) {
  console.error(e);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
