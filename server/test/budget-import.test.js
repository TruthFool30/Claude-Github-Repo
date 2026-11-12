// Bank statement import (DBS/POSB, UOB) + money insights. Fixtures: test/fixtures/statements (synthetic).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, familyFixture, registerUser, collectEvents, PNG_1X1 } from './helpers.js';
import * as F from './fixtures/statements/index.js';
import { addMonths, autoAmount, dateKey, daysInMonth, monthOf } from '../src/modules/budget/lib.js';
import { detectRecurring, maskDigits, merchantKey, parseAmount, parseDate } from '../src/modules/budget/import.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const today = dateKey();
const month = monthOf(today);
const LONG_DIGITS = /\d(?:[ -]?\d){7,}/;
/** No run of ≥ 8 digits in an API body, apart from its ISO dates/timestamps. */
const noLongDigits = (body) => !LONG_DIGITS.test(JSON.stringify(body).replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, ''));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (d) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const day = (m, d) => `${m}-${String(d).padStart(2, '0')}`;

/** A DBS-style CSV. rows: [isoDate, reference, description, signedAmount] */
function dbsCsv(rows, { account = '123-45678-4821', name = 'DBS Multiplier Account' } = {}) {
  const lines = [`Account Details For:,${name} ${account}`, `Statement as at:,${dmy(today)}`, '', 'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3'];
  for (const [d, ref, desc, amt] of rows) lines.push(`${dmy(d)},${ref},${amt < 0 ? (-amt).toFixed(2) : ''},${amt > 0 ? amt.toFixed(2) : ''},"${desc}",,`);
  return Buffer.from(lines.join('\n'));
}

async function household(name = 'Import Fam') {
  const f = await familyFixture(srv, name);
  const child = await registerUser(srv, { name: 'Kiddo' });
  await child.agent.post('/api/families/join', { invite_code: f.family.invite_code });
  assert.equal((await f.admin.agent.patch(`/api/family/members/${child.user.id}`, { role: 'child' })).status, 200);
  const cats = (await f.admin.agent.get('/api/budget/categories')).body;
  return { ...f, child, cats, cat: (n) => cats.find((c) => c.name === n) };
}

const preview = (agent, file, filename = 'statement.csv', fields = {}) =>
  agent.upload('/api/budget/imports/preview', { file, filename, type: 'application/octet-stream', fields });
async function importFile(agent, file, filename, body = {}) {
  const p = await preview(agent, file, filename);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await agent.post(`/api/budget/imports/${p.body.token}/commit`, { visibility: 'adults', ...body });
  return { preview: p.body, commit: c };
}

/** Every file under `dir` (recursively), best effort. */
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe('parsing helpers', () => {
  test('dates, amounts, masking, merchant keys', () => {
    assert.equal(parseDate('01 Nov 2026'), '2026-11-01');
    assert.equal(parseDate('1-Nov-26'), '2026-11-01');
    assert.equal(parseDate('05/11/2026'), '2026-11-05'); // day first
    assert.equal(parseDate('15 Dec', '2027-01-31'), '2026-12-15'); // year from the statement end
    assert.equal(parseDate(46000), '2025-12-09'); // Excel serial
    assert.equal(parseDate('31 Feb 2026'), null);
    assert.equal(parseAmount('1,234.56'), 123456);
    assert.equal(parseAmount('12.30 DR'), -1230);
    assert.equal(parseAmount('(5.00)'), -500);
    assert.equal(parseAmount('S$7.5'), 750);
    assert.equal(parseAmount('abc'), null);
    assert.equal(maskDigits('CARD 4111 1111 1111 1111 TO 91234567 ACCT 123-45678-4821 REF 1234567'), 'CARD ••1111 TO ••4567 ACCT ••4821 REF 1234567');
    assert.equal(merchantKey('NETFLIX.COM SINGAPORE SG'), 'NETFLIX');
    assert.equal(merchantKey('POS NTUC FP-SAMPLE BRANCH ••1234'), 'NTUC FP SAMPLE');
  });
  test('recurring detection wants one similar payment a month', () => {
    const it = (date, cents, statement = true) => ({ key: 'NETFLIX', kind: 'expense', amount_cents: cents, date, ref: date, statement });
    assert.equal(detectRecurring([it('2026-09-07', 1998), it('2026-10-07', 1998)]).length, 1);
    assert.equal(detectRecurring([it('2026-09-07', 1998, false), it('2026-10-08', 2050)])[0].months_seen, 2);
    assert.equal(detectRecurring([it('2026-10-07', 1998)]).length, 0); // one month only
    assert.equal(detectRecurring([it('2026-09-07', 1998), it('2026-10-07', 5000)]).length, 0); // amount differs > 10%
    assert.equal(detectRecurring([it('2026-09-07', 1998), it('2026-10-07', 1998), it('2026-10-20', 1998)]).length, 0); // twice a month
  });
});

describe('statement formats', () => {
  test('every bank × format previews with the same transactions', async () => {
    const h = await household('Formats');
    for (const bank of ['dbs', 'posb', 'uob']) {
      const { meta, rows } = F.statement(bank);
      for (const fmt of ['csv', 'xlsx', 'pdf']) {
        const res = await preview(h.admin.agent, F[fmt](bank), `export.${fmt}`);
        assert.equal(res.status, 200, `${bank} ${fmt}: ${JSON.stringify(res.body)}`);
        const p = res.body;
        assert.equal(p.bank, bank, `${bank} ${fmt}`);
        assert.equal(p.format, fmt);
        assert.equal(p.account.last4, meta.number.replace(/\D/g, '').slice(-4));
        assert.equal(p.account.label, `${bank.toUpperCase()} ••${p.account.last4}`);
        assert.equal(p.currency, 'SGD');
        assert.deepEqual(p.period, { from: meta.from, to: meta.to });
        assert.equal(p.closing_balance, meta.closing, `${bank} ${fmt} closing`);
        assert.equal(p.rows.length, rows.length, `${bank} ${fmt} rows`);
        p.rows.forEach((r, i) => {
          assert.equal(r.date, rows[i].date);
          assert.equal(r.amount, Math.abs(rows[i].amount));
          assert.equal(r.kind, rows[i].amount > 0 ? 'income' : 'expense');
          if (bank === 'uob' || fmt === 'pdf') assert.equal(r.balance, rows[i].balance);
        });
        if (bank === 'uob' || fmt === 'pdf') assert.equal(p.opening_balance, meta.opening);
        const byDesc = (re) => p.rows.find((r) => re.test(r.description));
        assert.equal(byDesc(/NTUC/).category_id, h.cat('Groceries').id);
        assert.equal(byDesc(/NTUC/).category_source, 'rule');
        assert.equal(byDesc(/NETFLIX/).category_id, h.cat('Entertainment').id);
        assert.equal(byDesc(/GRAB/).category_id, h.cat('Transport').id);
        assert.equal(byDesc(/BUS\/MRT/).category_id, h.cat('Transport').id);
        assert.equal(byDesc(/SINGTEL/).category_id, h.cat('Utilities').id);
        assert.equal(byDesc(/SHOPEE/).category_id, h.cat('Shopping').id);
        assert.equal(byDesc(/AIA/).category_id, h.cat('Health').id); // no Insurance category: Health
        assert.equal(byDesc(/SALARY/).category_id, h.cat('Salary').id);
        assert.equal(byDesc(/INTEREST/).category_id, h.cat('Side income').id);
        assert.equal(byDesc(/HARDWARE/).category_source, 'none');
        assert.equal(byDesc(/NETFLIX/).merchant, 'Netflix');
        assert.ok(byDesc(/PAYNOW/).description.includes('••4567'), byDesc(/PAYNOW/).description); // phone masked
        assert.ok(noLongDigits(p), `${bank} ${fmt}: long digit run in preview`);
        // Netflix, Singtel and the salary repeat monthly.
        const merchants = p.recurring.map((g) => g.merchant).sort();
        assert.deepEqual(merchants.filter((m) => /Netflix|Singtel|Salary/.test(m)).length, 3, merchants.join(','));
        assert.ok(!p.recurring.some((g) => /Ntuc/.test(g.merchant)), 'groceries twice in a month are not a bill');
        assert.equal(p.summary.count, rows.length);
        assert.equal(p.summary.duplicates, 0);
      }
    }
  });

  test('password-protected PDF: missing, wrong, right password', async () => {
    const h = await household('Locked');
    const file = F.pdf('uob', { password: F.PDF_PASSWORD });
    const none = await preview(h.admin.agent, file, 'e.pdf');
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'PASSWORD_REQUIRED');
    const wrong = await preview(h.admin.agent, file, 'e.pdf', { password: 'not-it' });
    assert.equal(wrong.body.code, 'BAD_PASSWORD');
    const right = await preview(h.admin.agent, file, 'e.pdf', { password: F.PDF_PASSWORD });
    assert.equal(right.status, 200);
    assert.equal(right.body.bank, 'uob');
    assert.equal(right.body.rows.length, F.statement('uob').rows.length);
  });

  test('anything else fails cleanly with the contract codes', async () => {
    const h = await household('Limits');
    const expect = async (file, name, code) => {
      const res = await preview(h.admin.agent, file, name);
      assert.equal(res.status, 400, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, code, `${name}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.error);
      return res.body;
    };
    const legacy = await expect(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]), 'history.xls', 'UNSUPPORTED');
    assert.match(legacy.error, /CSV/);
    await expect(Buffer.from('hello, world\nthis is not a statement\n'), 'notes.csv', 'UNSUPPORTED');
    await expect(Buffer.from('Date,Description,Amount\n01 Nov 2026,Coffee,-4.50\n'), 'other-bank.csv', 'UNSUPPORTED'); // no DBS/UOB marker
    await expect(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> garbage'), 'broken.pdf', 'UNSUPPORTED');
    await expect(F.zip([['hello.txt', 'hi']]), 'archive.xlsx', 'UNSUPPORTED');
    await expect(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'photo.png', 'UNSUPPORTED');
    await expect(dbsCsv([]), 'empty.csv', 'EMPTY');
    await expect(Buffer.alloc(10 * 1024 * 1024 + 10, 0x41), 'huge.csv', 'TOO_LARGE');
    // Zip bomb: a tiny .xlsx whose sheet inflates to ~200 MB.
    const bomb = F.zip([
      ['xl/workbook.xml', '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', Buffer.alloc(200 * 1024 * 1024, 0x20)],
    ]);
    assert.ok(bomb.length < 1024 * 1024);
    await expect(bomb, 'bomb.xlsx', 'TOO_LARGE');
    // A protected PDF with a huge "password" field is refused by the upload limits, not parsed.
    const big = await preview(h.admin.agent, F.csv('dbs'), 'x.csv', { password: 'x'.repeat(5000) });
    assert.equal(big.status, 400);
    // The server is still fine.
    assert.equal((await preview(h.admin.agent, F.csv('dbs'), 'ok.csv')).status, 200);
    // Children can't import or see insights.
    assert.equal((await preview(h.child.agent, F.csv('dbs'), 'x.csv')).status, 403);
    assert.equal((await h.child.agent.get('/api/budget/imports')).status, 403);
    assert.equal((await h.child.agent.get('/api/budget/insights')).status, 403);
    const expired = await h.admin.agent.post('/api/budget/imports/nope/commit', {});
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'EXPIRED');
    // Someone else's token is just as unknown.
    const mine = await preview(h.admin.agent, F.csv('dbs'), 'ok.csv');
    assert.equal((await h.member.agent.post(`/api/budget/imports/${mine.body.token}/commit`, {})).body.code, 'EXPIRED');
  });
});

describe('privacy', () => {
  test('the file never touches the disk; descriptions and balances are sealed; no long numbers survive', async () => {
    const h = await household('Privacy');
    const marker = 'ZZDISKMARKER7731';
    const file = dbsCsv([
      [day(month, 1), 'POS', `${marker} SHOP CARD 4111-2222-3333-4444`, -12.3],
      [day(month, 1), 'ICT', 'PAYNOW TO 9876 5432 SAMPLE', -40],
      [day(month, 1), 'GIRO', 'SALARY SAMPLECO ACCT 0011223344556', 3000],
    ], { account: '555-66677-8899' });
    const tmpBefore = new Set(walk(os.tmpdir()));
    const { preview: p, commit } = await importFile(h.admin.agent, file, 'dbs.csv');
    assert.equal(commit.status, 201, JSON.stringify(commit.body));
    await preview(h.admin.agent, Buffer.concat([Buffer.from(marker), Buffer.alloc(11 * 1024 * 1024)]), 'big.csv'); // error path
    await preview(h.admin.agent, Buffer.from(`${marker} not a statement`), 'bad.csv'); // error path
    // Nothing written to the upload dir, and no new temp file holds the upload.
    assert.deepEqual(walk(path.join(srv.dir, 'uploads')), []);
    for (const f of walk(os.tmpdir()).filter((x) => !tmpBefore.has(x) && !x.startsWith(srv.dir))) {
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      assert.ok(!buf.includes(marker), `upload content found in ${f}`);
    }
    // Sealed at rest.
    const rows = srv.db.prepare('SELECT description, balance, visibility FROM budget_transactions WHERE import_id = ?').all(commit.body.import.id);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.ok(r.description.startsWith('enc:v1:'));
      assert.equal(r.visibility, 'adults');
    }
    const imp = srv.db.prepare('SELECT * FROM budget_imports WHERE id = ?').get(commit.body.import.id);
    assert.equal(imp.account_label, 'DBS ••8899');
    // API output: masked, no long digit runs.
    const list = await h.admin.agent.get(`/api/budget/transactions?import_id=${commit.body.import.id}`);
    assert.equal(list.status, 200);
    assert.ok(list.body.some((t) => t.description === `POS ${marker} SHOP CARD ••4444`), JSON.stringify(list.body));
    assert.ok(list.body.some((t) => /PAYNOW TO ••5432/.test(t.description)));
    for (const body of [p, commit.body, list.body, (await h.admin.agent.get('/api/budget/imports')).body]) assert.ok(noLongDigits(body), JSON.stringify(body));
    // Raw database files: neither the numbers nor the descriptions are there in plain text.
    srv.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const raw = Buffer.concat(walk(srv.dir).filter((f) => /test\.db/.test(f)).map((f) => fs.readFileSync(f)));
    for (const needle of [marker, 'SHOP CARD', 'PAYNOW', '4111-2222-3333-4444', '98765432', '9876 5432', '0011223344556', '555-66677-8899', '55566677', 'SAMPLECO']) {
      assert.ok(!raw.includes(Buffer.from(needle)), `found ${needle} in the database file`);
    }
  });

  test('visibility on every read path: importer, other adult, child', async () => {
    const h = await household('Visibility');
    const marker = 'VISMARK';
    // Admin imports for the grown-ups, the member imports privately.
    const a = await importFile(h.admin.agent, dbsCsv([
      [day(month, 1), 'POS', `NTUC ${marker}ADULT`, -111.11],
      [day(month, 1), 'GIRO', 'SALARY SAMPLECO', 2222.22],
    ]), 'a.csv');
    assert.equal(a.commit.status, 201);
    const prevMonth = addMonths(month, -1);
    const m = await importFile(h.member.agent, dbsCsv([
      [day(prevMonth, 5), 'UMC', `NETFLIX ${marker}PRIV`, -19.98],
      [day(month, 5), 'UMC', `NETFLIX ${marker}PRIV`, -19.98],
      [day(month, 2), 'POS', `SHOPEE ${marker}PRIV`, -333.33],
    ], { account: '999-88877-1234', name: 'POSB Savings Account' }), 'm.csv', { visibility: 'private', bills: [] });
    assert.equal(m.commit.status, 201);
    const group = m.preview.recurring.find((g) => /^Netflix/.test(g.merchant));
    assert.ok(group, JSON.stringify(m.preview.recurring));
    // Accept the Netflix bill on a second, private import of the next statement... here: re-preview + commit with the bill.
    const m2 = await importFile(h.member.agent, dbsCsv([[day(month, 3), 'POS', `GIANT ${marker}PRIV2`, -5]], { account: '999-88877-1234', name: 'POSB Savings Account' }), 'm2.csv', { visibility: 'private' });
    assert.equal(m2.commit.status, 201);
    // A private bill: commit the first preview again is impossible (single-use token).
    assert.equal((await h.member.agent.post(`/api/budget/imports/${m.preview.token}/commit`, {})).status, 410);

    const txs = async (agent) => (await agent.get(`/api/budget/transactions?month=${month}`)).body;
    const descs = (list) => list.map((t) => t.description).join('|');
    assert.match(descs(await txs(h.admin.agent)), /VISMARKADULT/);
    assert.doesNotMatch(descs(await txs(h.admin.agent)), /VISMARKPRIV/);
    assert.match(descs(await txs(h.member.agent)), /VISMARKADULT/);
    assert.match(descs(await txs(h.member.agent)), /VISMARKPRIV/);
    assert.doesNotMatch(descs(await txs(h.child.agent)), /VISMARK/);
    // Single rows: 404 for those who can't see them.
    const privId = (await txs(h.member.agent)).find((t) => /SHOPEE/.test(t.description)).id;
    const adultId = (await txs(h.admin.agent)).find((t) => /VISMARKADULT/.test(t.description)).id;
    assert.equal((await h.admin.agent.get(`/api/budget/transactions/${privId}`)).status, 404);
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${privId}`, { amount: 1 })).status, 404);
    assert.equal((await h.admin.agent.del(`/api/budget/transactions/${privId}`)).status, 404);
    assert.equal((await h.child.agent.get(`/api/budget/transactions/${adultId}`)).status, 404);
    const own = await h.member.agent.get(`/api/budget/transactions/${privId}`);
    assert.equal(own.body.visibility, 'private');
    assert.ok(own.body.import_id);
    assert.equal(own.body.import_label, 'POSB ••1234');
    // Search inside sealed descriptions (list + global search).
    assert.equal((await h.member.agent.get('/api/budget/transactions?q=vismarkpriv&all=1')).body.length, 4);
    assert.equal((await h.admin.agent.get('/api/budget/transactions?q=vismarkpriv&all=1')).body.length, 0);
    assert.equal((await h.admin.agent.get('/api/budget/transactions?q=vismarkadult&all=1')).body.length, 1);
    const gs = async (agent, q) => (await agent.get(`/api/search?q=${q}`)).body.results.filter((x) => x.module === 'budget');
    assert.equal((await gs(h.member.agent, 'VISMARKPRIV')).length, 4);
    assert.equal((await gs(h.admin.agent, 'VISMARKPRIV')).length, 0);
    assert.equal((await gs(h.admin.agent, 'VISMARKADULT')).length, 1);
    assert.equal((await gs(h.child.agent, 'VISMARK')).length, 0);
    // Summary / dashboard totals.
    const spent = async (agent) => (await agent.get(`/api/budget/summary?month=${month}`)).body.totals.spent;
    assert.equal(await spent(h.child.agent), 0);
    assert.equal(await spent(h.admin.agent), 111.11);
    assert.equal(await spent(h.member.agent), 469.42);
    assert.equal((await h.child.agent.get('/api/dashboard')).body.budget.spent, 0);
    assert.equal((await h.admin.agent.get('/api/dashboard')).body.budget.income, 2222.22);
    const shopping = (await h.admin.agent.get(`/api/budget/summary?month=${month}`)).body.categories.find((c) => c.name === 'Shopping');
    assert.equal(shopping.total, 0);
    // Imports list.
    assert.equal((await h.admin.agent.get('/api/budget/imports')).body.length, 1);
    assert.equal((await h.member.agent.get('/api/budget/imports')).body.length, 3);
    // Insights.
    const ins = async (agent) => (await agent.get('/api/budget/insights?months=3')).body;
    assert.equal((await ins(h.admin.agent)).months.at(-1).spending, 111.11);
    assert.equal((await ins(h.member.agent)).months.at(-1).spending, 469.42);
    assert.deepEqual((await ins(h.admin.agent)).balances, []); // CSV without a ledger line: no balance
    // Wall / activity / notifications: one entry per import, only for its audience, no amounts.
    const acts = async (agent) => (await agent.get('/api/activity?module=budget')).body.filter((x) => x.verb === 'imported');
    const adminActs = await acts(h.admin.agent);
    assert.equal(adminActs.length, 1);
    assert.equal(adminActs[0].summary, 'imported 2 transactions from DBS ••4821');
    assert.equal((await acts(h.member.agent)).length, 3); // the adults import + their two private ones
    assert.equal((await acts(h.child.agent)).length, 0);
    const wall = async (agent) => JSON.stringify((await agent.get('/api/wall/feed?filter=activity&limit=50')).body);
    assert.doesNotMatch(await wall(h.child.agent), /imported/);
    assert.doesNotMatch(await wall(h.admin.agent), /POSB/);
    for (const agent of [h.admin.agent, h.member.agent, h.child.agent]) {
      const n = JSON.stringify((await agent.get('/api/notifications')).body);
      assert.doesNotMatch(n, /VISMARK|imported|333|111\.11/);
    }
  });

  test('live events reach only the import audience', async () => {
    const h = await household('Events');
    const childEvents = await collectEvents(h.child.agent, { timeoutMs: 2500, until: (e) => e.type === 'never' });
    const memberEvents = await collectEvents(h.member.agent, { timeoutMs: 2500, until: (e) => e.type === 'never' });
    const { commit } = await importFile(h.admin.agent, dbsCsv([[day(month, 1), 'POS', 'NTUC EVENTS', -5]]), 'e.csv', { visibility: 'private' });
    assert.equal(commit.status, 201);
    const c = (await childEvents.events).map((e) => e.type);
    const mem = (await memberEvents.events).map((e) => e.type);
    assert.ok(!c.some((t) => /import|transaction|activity/.test(t)), c.join(','));
    assert.ok(!mem.some((t) => /import|transaction|activity/.test(t)), mem.join(','));
  });

  test('manual transactions: visibility can be changed by grown-ups; the Wall entry follows', async () => {
    const h = await household('Manual vis');
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 42, description: 'Secret gift', category_id: h.cat('Shopping').id });
    assert.equal(t.body.visibility, 'family');
    assert.equal((await h.child.agent.get(`/api/budget/transactions/${t.body.id}`)).status, 200);
    assert.equal((await h.child.agent.post('/api/budget/transactions', { amount: 2, visibility: 'adults' })).status, 403);
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'private' })).status, 403); // not theirs
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'nope' })).status, 400);
    const p = await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'adults' });
    assert.equal(p.body.visibility, 'adults');
    assert.equal((await h.child.agent.get(`/api/budget/transactions/${t.body.id}`)).status, 404);
    const entry = async (agent) => (await agent.get('/api/activity')).body.find((a) => a.module === 'budget' && a.entity_id === t.body.id);
    assert.equal(await entry(h.child.agent), undefined);
    assert.equal((await entry(h.member.agent)).summary, 'added an expense · $42.00'); // the description left the Wall line
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'private' });
    assert.equal((await h.member.agent.get(`/api/budget/transactions/${t.body.id}`)).status, 404);
    assert.equal(await entry(h.member.agent), undefined);
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'family' });
    assert.ok(await entry(h.child.agent));
  });
});

describe('import flow', () => {
  test('duplicates: against earlier imports, manual rows and within the file', async () => {
    const h = await household('Dupes');
    const first = await importFile(h.admin.agent, F.csv('dbs'), 'dbs.csv');
    assert.equal(first.commit.status, 201);
    assert.equal(first.commit.body.created, F.statement('dbs').rows.length);
    const again = await preview(h.admin.agent, F.csv('dbs'), 'dbs.csv');
    assert.equal(again.body.summary.duplicates, F.statement('dbs').rows.length);
    assert.ok(again.body.rows.every((r) => r.duplicate));
    const empty = await h.admin.agent.post(`/api/budget/imports/${again.body.token}/commit`, { visibility: 'adults' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'EMPTY');
    // The same account as a PDF overlaps too (same last 4, dates, amounts, descriptions).
    const pdf = await preview(h.admin.agent, F.pdf('dbs'), 'dbs.pdf');
    assert.equal(pdf.body.summary.duplicates, F.statement('dbs').rows.length);
    // A different account with the same lines is not a duplicate.
    const posb = await preview(h.admin.agent, F.csv('posb'), 'posb.csv');
    assert.equal(posb.body.summary.duplicates, 0);
    // Manual entry with the same date, amount and description.
    await h.admin.agent.post('/api/budget/transactions', { amount: 7.7, description: 'MANUAL DUP', date: day(month, 1) });
    const withManual = await preview(h.admin.agent, dbsCsv([
      [day(month, 1), 'POS', 'MANUAL DUP', -7.7],
      [day(month, 1), 'POS', 'COFFEE', -3],
      [day(month, 1), 'POS', 'COFFEE', -3],
    ], { account: '000-11122-3333' }), 'x.csv');
    assert.deepEqual(withManual.body.rows.map((r) => r.duplicate), [true, false, true]);
    // Forcing a duplicate in explicitly works; skipped_duplicates counts the rest.
    const forced = await h.admin.agent.post(`/api/budget/imports/${withManual.body.token}/commit`, { rows: [{ row_id: withManual.body.rows[2].row_id, include: true }] });
    assert.equal(forced.status, 201);
    assert.equal(forced.body.created, 2);
    assert.equal(forced.body.skipped_duplicates, 1);
    assert.equal(forced.body.excluded, 0);
    // Unticked rows are counted apart from duplicates.
    const two = await preview(h.admin.agent, dbsCsv([[day(month, 2), 'POS', 'TEA', -2], [day(month, 2), 'POS', 'CAKE', -4]], { account: '000-11122-4444' }), 'y.csv');
    const ex = await h.admin.agent.post(`/api/budget/imports/${two.body.token}/commit`, { rows: [{ row_id: two.body.rows[1].row_id, include: false }] });
    assert.deepEqual([ex.body.created, ex.body.skipped_duplicates, ex.body.excluded], [1, 0, 1]);
    // Identical lines with different running balances (UOB) are distinct.
    const uobRows = ['United Overseas Bank Limited', 'Account Number:,123-456-789-0', '', 'Transaction Date,Transaction Description,Withdrawal,Deposit,Available Balance',
      `${dmy(day(month, 1))},BUS/MRT,1.00,,99.00`, `${dmy(day(month, 1))},BUS/MRT,1.00,,98.00`].join('\n');
    const uob = await preview(h.admin.agent, Buffer.from(uobRows), 'uob.csv');
    assert.deepEqual(uob.body.rows.map((r) => r.duplicate), [false, false]);
  });

  test('categories: overrides are validated and learned; learned rules beat built-ins', async () => {
    const h = await household('Learning');
    const file = dbsCsv([[day(month, 1), 'POS', 'SAMPLE HARDWARE TRADING', -42], [day(month, 2), 'POS', 'NTUC FP-SAMPLE', -10]]);
    const p = await preview(h.admin.agent, file, 'l.csv');
    const [hw, ntuc] = p.body.rows;
    assert.equal(hw.category_source, 'none');
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { rows: [{ row_id: hw.row_id, category_id: h.cat('Salary').id }] })).status, 400);
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { rows: [{ row_id: 'r999' }] })).status, 400);
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { visibility: 'family' })).status, 400);
    const c = await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, {
      rows: [{ row_id: hw.row_id, category_id: h.cat('Shopping').id, include: true }, { row_id: ntuc.row_id, category_id: h.cat('Dining').id }],
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const rules = srv.db.prepare('SELECT * FROM budget_merchant_rules WHERE family_id = ?').all(h.family.id);
    assert.equal(rules.length, 2);
    assert.ok(rules.every((r) => r.merchant.startsWith('enc:v1:')));
    const next = await preview(h.admin.agent, dbsCsv([[day(month, 3), 'POS', 'SAMPLE HARDWARE TRADING', -9], [day(month, 3), 'POS', 'NTUC FP-SAMPLE', -11]]), 'l2.csv');
    assert.equal(next.body.rows[0].category_id, h.cat('Shopping').id);
    assert.equal(next.body.rows[0].category_source, 'learned');
    assert.equal(next.body.rows[1].category_id, h.cat('Dining').id);
    assert.equal(next.body.rows[1].category_source, 'learned');
    // Another family doesn't share the rules.
    const other = await household('Learning 2');
    assert.equal((await preview(other.admin.agent, file, 'l.csv')).body.rows[0].category_source, 'none');
  });

  test('recurring suggestions create bills once, matched to existing bills', async () => {
    const h = await household('Bills');
    const p = await preview(h.admin.agent, F.csv('dbs'), 'dbs.csv');
    const netflix = p.body.recurring.find((g) => g.merchant === 'Netflix');
    const singtel = p.body.recurring.find((g) => g.merchant === 'Singtel Mobile');
    assert.ok(netflix && singtel, JSON.stringify(p.body.recurring));
    assert.equal(netflix.amount, 19.98);
    assert.equal(netflix.day_of_month, 7);
    assert.equal(netflix.months_seen, 2);
    assert.equal(netflix.category_id, h.cat('Entertainment').id);
    assert.equal(netflix.existing_bill_id, null);
    assert.equal(p.body.rows.filter((r) => r.recurring_group === netflix.group).length, 2);
    // An existing bill is recognised.
    const phone = await h.admin.agent.post('/api/budget/recurring', { description: 'Singtel mobile plan', amount: 97, day_of_month: 18, category_id: h.cat('Utilities').id });
    const p2 = await preview(h.admin.agent, F.csv('dbs'), 'dbs.csv');
    assert.equal(p2.body.recurring.find((g) => g.merchant === 'Singtel Mobile').existing_bill_id, phone.body.id);
    const g2 = p2.body.recurring.find((g) => g.merchant === 'Netflix');
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p2.body.token}/commit`, { bills: [{ group: 'nope' }] })).status, 400);
    const c = await h.admin.agent.post(`/api/budget/imports/${p2.body.token}/commit`, {
      bills: [{ group: g2.group, description: 'Netflix 1234567890' }, { group: p2.body.recurring.find((g) => g.merchant === 'Singtel Mobile').group }],
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.bills_created, 1); // Singtel already had a bill
    const bills = srv.db.prepare('SELECT * FROM budget_recurring WHERE family_id = ? AND visibility = ?').all(h.family.id, 'adults');
    assert.equal(bills.length, 1);
    assert.ok(bills[0].description.startsWith('enc:v1:')); // a bill from an import has its name sealed
    assert.equal(srv.ctx.box.open(bills[0].description), 'Netflix ••7890');
    assert.equal(bills[0].visibility, 'adults');
    assert.equal(bills[0].auto_create, 0);
    assert.equal(bills[0].start_month, '2026-11'); // the month after its latest payment
    // October is paid by the imported payment; no extra transaction was created.
    const oct = (await h.admin.agent.get('/api/budget/recurring?month=2026-10')).body.find((b) => b.id === bills[0].id);
    assert.equal(oct.status, 'paid');
    assert.equal(oct.paid_amount, 19.98);
    // September and October's imported payments are linked; no extra transaction was created.
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND recurring_id = ? AND import_id IS NOT NULL").get(h.family.id, bills[0].id).n, 2);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND recurring_id = ?").get(h.family.id, bills[0].id).n, 2);
    // Kids don't see the adults' bill (list, badge, search).
    assert.ok(!(await h.child.agent.get('/api/budget/recurring?month=2026-10')).body.some((b) => b.id === bills[0].id));
    assert.ok(!(await h.child.agent.get('/api/search?q=netflix')).body.results.some((x) => x.module === 'budget'));
    // The next statement's Netflix now matches the bill.
    const p3 = await preview(h.admin.agent, dbsCsv([['2026-11-07', 'UMC', 'NETFLIX.COM SINGAPORE SG', -19.98]]), 'nov.csv');
    assert.equal(p3.body.recurring.find((g) => g.merchant === 'Netflix').existing_bill_id, bills[0].id);
  });

  test('undo an import', async () => {
    const h = await household('Undo');
    const { commit } = await importFile(h.admin.agent, F.csv('uob'), 'uob.csv');
    const id = commit.body.import.id;
    assert.equal(commit.body.import.row_count, F.statement('uob').rows.length);
    assert.equal(commit.body.import.account_label, 'UOB ••7890');
    const someTx = (await h.admin.agent.get(`/api/budget/transactions?import_id=${id}`)).body[0];
    assert.equal((await h.member.agent.get('/api/activity?module=budget')).body.filter((a) => a.verb === 'imported').length, 1);
    const del = await h.admin.agent.del(`/api/budget/imports/${id}`);
    assert.deepEqual(del.body, { ok: true, removed: F.statement('uob').rows.length });
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?import_id=${id}`)).body.length, 0);
    assert.equal((await h.admin.agent.get('/api/budget/imports')).body.length, 0);
    assert.equal((await h.member.agent.get('/api/activity?module=budget')).body.filter((a) => a.verb === 'imported').length, 0);
    assert.equal((await h.admin.agent.post(`/api/budget/transactions/${someTx.id}/restore`)).status, 409);
    assert.equal((await h.admin.agent.del(`/api/budget/imports/${id}`)).status, 404);
    // After undo the same statement is new again.
    assert.equal((await preview(h.admin.agent, F.csv('uob'), 'uob.csv')).body.summary.duplicates, 0);
    // A private import can't be undone by another adult.
    const priv = await importFile(h.member.agent, F.csv('posb'), 'posb.csv', { visibility: 'private' });
    assert.equal((await h.admin.agent.del(`/api/budget/imports/${priv.commit.body.import.id}`)).status, 404);
  });

  test('a member leaving takes their private import with them', async () => {
    const h = await household('Leaving');
    const priv = await importFile(h.member.agent, F.csv('posb'), 'posb.csv', { visibility: 'private' });
    assert.equal(priv.commit.status, 201);
    assert.equal((await h.admin.agent.del(`/api/family/members/${h.member.user.id}`)).status, 200);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND visibility = ?').get(h.family.id, 'private').n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_imports WHERE family_id = ?').get(h.family.id).n, 0);
  });
});

describe('insights', () => {
  test('averages over full months, partial month, spikes, goals short with suggestions', async () => {
    const h = await household('Insights');
    const add = (body) => h.admin.agent.post('/api/budget/transactions', body);
    for (let i = 1; i <= 3; i++) {
      const m = addMonths(month, -i);
      await add({ kind: 'income', amount: 5000, date: day(m, 10), description: 'Pay', category_id: h.cat('Salary').id });
      await add({ amount: 1000, date: day(m, 11), description: 'NTUC FairPrice', category_id: h.cat('Groceries').id });
      await add({ amount: 400, date: day(m, 1), description: 'Dinner out', category_id: h.cat('Dining').id });
      await add({ amount: 2000, date: day(m, 1), description: 'Mortgage', category_id: h.cat('Housing').id });
    }
    await add({ amount: 900, date: day(month, 1), description: 'Dinner out', category_id: h.cat('Dining').id });
    // The mortgage on the 1st, as every month: usual by now, whatever day it is — not a spike.
    await add({ amount: 2000, date: day(month, 1), description: 'Mortgage', category_id: h.cat('Housing').id });
    // Older than the window: ignored.
    await add({ kind: 'income', amount: 99999, date: day(addMonths(month, -5), 1) });
    const target = `${addMonths(month, 9)}-15`;
    const goal = await h.admin.agent.post('/api/budget/goals', { name: 'House', emoji: '🏠', target: 50000, target_date: target });
    await h.admin.agent.post('/api/budget/goals', { name: 'Someday', target: 100 });
    const res = await h.admin.agent.get('/api/budget/insights?months=3');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ins = res.body;
    assert.equal(ins.months.length, 4);
    assert.deepEqual(ins.months.map((m) => m.partial), [false, false, false, true]);
    assert.equal(ins.months[3].month, month);
    assert.equal(ins.months[3].spending, 2900);
    assert.equal(ins.today, today);
    assert.equal(ins.avg_income, 5000);
    assert.equal(ins.avg_spending, 3400);
    assert.equal(ins.avg_surplus, 1600);
    // This month so far against what earlier months had spent by the same day (both on the 1st).
    const dining = ins.categories.find((c) => c.name === 'Dining');
    assert.deepEqual([dining.avg, dining.avg_to_date, dining.this_month, dining.change_pct], [400, 400, 900, 125]);
    const housing = ins.categories.find((c) => c.name === 'Housing');
    assert.deepEqual([housing.avg_to_date, housing.this_month, housing.change_pct], [2000, 2000, 0]);
    assert.deepEqual(ins.spikes.map((s) => [s.name, s.usual_by_now, s.change_pct]), [['Dining', 400, 125]]);
    assert.equal(ins.categories[0].name, 'Housing'); // biggest average first
    assert.deepEqual(ins.merchants.slice(0, 2).map((m) => [m.merchant, m.total]), [['Mortgage', 8000], ['Ntuc Fairprice', 3000]]);
    const monthly = autoAmount(5_000_000, month, target) / 100;
    assert.equal(ins.goals.needed_monthly, monthly);
    assert.equal(ins.goals.items[0].id, goal.body.id);
    assert.equal(ins.goals.undated, 1);
    assert.equal(ins.goals.status, 'short');
    assert.equal(ins.goals.shortfall, Math.round((monthly - 1600) * 100) / 100);
    // Alternatives, best first: pushing the date closes the gap; trimming Dining by a quarter doesn't.
    const [move, groceries, trimDining] = ins.goals.suggestions;
    assert.match(move, /^Move 🏠 House from .+ to .+ frees up .+ closes the gap\.$/);
    // Trims are only the saving (how this month compares is in Categories), never "$0.00 so far".
    assert.match(groceries, /^Spending \$250\.00 less on Groceries each month would leave you \$[\d,.]+ a month short\.$/);
    assert.match(trimDining, /^Spending \$100\.00 less on Dining each month would leave you \$[\d,.]+ a month short\.$/);
    assert.equal(ins.goals.suggestions.length, 3);
    assert.equal(ins.goals.remaining_gap, 0);
    assert.deepEqual(ins.goals.overdue, []);
    assert.equal((await h.admin.agent.get('/api/budget/insights?months=0')).status, 400);
    assert.equal((await h.admin.agent.get('/api/budget/insights?months=abc')).status, 400);
    // On track with a small goal; balances from an imported statement.
    const ok = await household('Insights OK');
    await ok.admin.agent.post('/api/budget/transactions', { kind: 'income', amount: 3000, date: day(addMonths(month, -1), 3) });
    await ok.admin.agent.post('/api/budget/goals', { name: 'Bike', target: 600, target_date: `${addMonths(month, 5)}-01` });
    await importFile(ok.admin.agent, F.csv('dbs'), 'dbs.csv');
    const ins2 = (await ok.admin.agent.get('/api/budget/insights?months=1')).body;
    assert.equal(ins2.goals.status, 'on_track');
    assert.equal(ins2.goals.shortfall, 0);
    assert.match(ins2.goals.suggestions[0], /to spare/);
    assert.deepEqual(ins2.balances, [{ account_label: 'DBS ••4821', balance: F.statement('dbs').meta.closing, as_of: '2026-10-31', statement_to: '2026-10-31', stale: false }]);
    // No data at all.
    const none = await household('Insights none');
    const ins3 = (await none.admin.agent.get('/api/budget/insights')).body;
    assert.equal(ins3.goals.status, 'no_data');
    assert.equal(ins3.months.length, 4);
  });

  test('the demo family gets meaningful insights', async () => {
    const demo = await startServer();
    try {
      const { seedDemo, DEMO_PASSWORD } = await import('../src/seed.js');
      await seedDemo(demo.ctx, demo.app.locals.modules, { log: () => {} });
      const alex = demo.agent();
      assert.equal((await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: DEMO_PASSWORD })).status, 200);
      const ins = (await alex.get('/api/budget/insights')).body;
      assert.ok(ins.avg_income > 0 && ins.avg_spending > 0);
      assert.ok(['on_track', 'short'].includes(ins.goals.status));
      assert.ok(ins.goals.items.length >= 1);
      assert.ok(ins.recurring.total_monthly > 0);
      assert.ok(ins.goals.suggestions.length >= 1);
    } finally {
      await demo.close();
    }
  });
});

describe('security review fixes', () => {
  /** Resident memory of this process's child processes (the statement parsers), Linux only. */
  const childRss = () => {
    let sum = 0;
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        if (Number(/PPid:\s+(\d+)/.exec(st)?.[1]) === process.pid) sum += Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0) * 1024;
      } catch { /* gone */ }
    }
    return sum;
  };

  test('learned rules stay on their side of the privacy line', async () => {
    const h = await household('Rules privacy');
    const secret = dbsCsv([[day(month, 3), 'POS', 'POS SECRETCLINIC PSYCH', -85.4]], { account: '999-99999-1111' });
    const p = await preview(h.admin.agent, secret, 's.csv');
    const c = await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { visibility: 'private', rows: [{ row_id: 'r1', category_id: h.cat('Health').id }] });
    assert.equal(c.status, 201);
    const probe = dbsCsv([[day(month, 4), 'POS', 'SECRETCLINIC PSYCH', -1]], { account: '999-99999-7777' });
    const sam = await preview(h.member.agent, probe, 'p.csv');
    assert.equal(sam.body.rows[0].category_source, 'none'); // no oracle for the other adult
    assert.equal(sam.body.rows[0].category_id, null);
    const alex = await preview(h.admin.agent, probe, 'p.csv');
    assert.equal(alex.body.rows[0].category_source, 'learned'); // the importer still benefits
    // A rule from an adults import is shared with the grown-ups; the importer's private rule wins for them.
    const shared = await preview(h.member.agent, dbsCsv([[day(month, 5), 'POS', 'SECRETCLINIC PSYCH', -2]], { account: '999-99999-7777' }), 'q.csv');
    assert.equal((await h.member.agent.post(`/api/budget/imports/${shared.body.token}/commit`, { rows: [{ row_id: 'r1', category_id: h.cat('Other').id }] })).status, 201);
    assert.equal((await preview(h.admin.agent, probe, 'p.csv')).body.rows[0].category_id, h.cat('Health').id);
    const other = await registerUser(srv, { name: 'Other adult' });
    await other.agent.post('/api/families/join', { invite_code: h.family.invite_code });
    assert.equal((await preview(other.agent, probe, 'p.csv')).body.rows[0].category_id, h.cat('Other').id);
    // Undo removes the rules that import set.
    const imports = (await h.member.agent.get('/api/budget/imports')).body;
    await h.member.agent.del(`/api/budget/imports/${imports.find((i) => i.account_label === 'DBS ••7777').id}`);
    assert.equal((await preview(other.agent, probe, 'p.csv')).body.rows[0].category_source, 'none');
    // Leaving removes someone's private rules (Alex's stays while Sam leaves; gone when Alex's own private ones go).
    const priv = () => srv.db.prepare("SELECT COUNT(*) AS n FROM budget_merchant_rules WHERE family_id = ? AND visibility = 'private'").get(h.family.id).n;
    assert.equal(priv(), 1);
    srv.ctx.memberEvent('left', { familyId: h.family.id, userId: h.admin.user.id, reason: 'left' });
    assert.equal(priv(), 0);
  });

  test('a PDF decompression bomb is stopped with bounded memory, which is given back', { skip: !fs.existsSync('/proc/self/status') }, async () => {
    const h = await household('Bomb');
    const second = await registerUser(srv, { name: 'Second adult' });
    await second.agent.post('/api/families/join', { invite_code: h.family.invite_code });
    const bomb = await F.bombPdf(3 * 1024 * 1024 * 1024); // ~3 MB inflating to 3 GB
    assert.ok(bomb.length < 4 * 1024 * 1024);
    const mainBefore = process.memoryUsage.rss();
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, childRss()); }, 20);
    const [a, b] = await Promise.all([preview(h.admin.agent, bomb, 'bomb.pdf'), preview(second.agent, bomb, 'bomb.pdf')]);
    clearInterval(watch);
    assert.deepEqual([a.body.code, b.body.code], ['TOO_LARGE', 'TOO_LARGE']);
    assert.ok(peak < 2 * 400 * 1024 * 1024, `parsers peaked at ${Math.round(peak / 1e6)} MB`);
    assert.ok(process.memoryUsage.rss() - mainBefore < 150 * 1024 * 1024, 'the server process itself did not grow');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(childRss(), 0, 'parser processes are gone');
    assert.equal((await preview(h.admin.agent, F.pdf('dbs'), 'ok.pdf')).status, 200);
  });

  test('one parse per person, bounded queue; broken xlsx XML is read in linear time', async () => {
    const h = await household('Busy');
    const bomb = await F.bombPdf(1024 * 1024 * 1024);
    const [slow, fast] = await Promise.all([
      preview(h.admin.agent, bomb, 'b.pdf'),
      new Promise((r) => setTimeout(r, 150)).then(() => preview(h.admin.agent, F.csv('dbs'), 'x.csv')),
    ]);
    assert.equal(slow.body.code, 'TOO_LARGE');
    assert.equal(fast.status, 429);
    assert.equal(fast.body.code, 'BUSY');
    const wb = '<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>';
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
    for (const [name, xml] of [
      ['xl/sharedStrings.xml', '<si>'.repeat(2_000_000)], ['xl/worksheets/sheet1.xml', '<row>'.repeat(2_000_000)],
      ['xl/worksheets/sheet1.xml', `<row>${'<c>'.repeat(3_000_000)}</row>`], ['xl/worksheets/sheet1.xml', `<row>${'<c r="A1"><v>'.repeat(500_000)}</row>`],
      ['xl/workbook.xml', '<sheet'.repeat(2_000_000)],
    ]) {
      const files = new Map([['xl/workbook.xml', wb], ['xl/_rels/workbook.xml.rels', rels], ['xl/worksheets/sheet1.xml', '<row></row>'], [name, xml]]);
      const t0 = Date.now();
      const res = await preview(h.admin.agent, F.zip([...files]), 'x.xlsx');
      assert.equal(res.status, 400);
      assert.ok(Date.now() - t0 < 5000, `${name} took ${Date.now() - t0} ms`);
    }
  });

  test('masking covers separators, Unicode digits and NRIC/FIN; the holder name becomes (you)', async () => {
    for (const [input, out] of [
      ['CARD 4111.1111.1111.1111', 'CARD ••1111'], ['4111/1111/1111/1111', '••1111'], ['4111_1111_1111_1111', '••1111'],
      ['TO 4111 - 1111 - 1111 - 1111', 'TO ••1111'], ['4111–1111–1111–1111', '••1111'], ['4111—1111—1111—1111', '••1111'],
      ['PAN ４１１１１１１１１１１１１１１１', 'PAN ••1111'], ['٤١١١١١١١١١', '••1111'], ['ACCT 123/456789/0', 'ACCT ••7890'],
      ['IRAS TAX S1234567A', 'IRAS TAX •••••••••'], ['fin g7654321x', 'fin •••••••••'], ['IBAN GB82WEST12345698765432', 'IBAN GB82WEST••5432'],
      ['1234*5678*9012', '••9012'], ['+65 9123 4567', '+••4567'], ['  A\t\tB  ', 'A B'],
      // Amounts, dates and short numbers stay.
      ['SGD 1,234.56 12.30 45.60 ON 01/11/2026 2026-11-01 REF 1234567', 'SGD 1,234.56 12.30 45.60 ON 01/11/2026 2026-11-01 REF 1234567'],
    ]) assert.equal(maskDigits(input), out, input);
    const h = await household('Masking');
    const leak = Buffer.from(['Account Details For:,DBS Multiplier Account 123-45678-4821', 'Name:,ALEX RIVERA', 'Address:,BLK 123 SECRET STREET #12-34 S123456', '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3',
      `${dmy(day(month, 1))},FAST,10.00,,CARD 4111.1111.1111.1111,,`, `${dmy(day(month, 1))},ICT,,50.00,FROM ALEX  RIVERA,,`,
      `${dmy(day(month, 2))},ICT,20.00,,TO JOHN TAN,,`].join('\n'));
    const p = await preview(h.admin.agent, leak, 'leak.csv');
    assert.deepEqual(p.body.rows.map((r) => r.description), ['FAST CARD ••1111', 'ICT FROM (you)', 'ICT TO JOHN TAN']);
    assert.doesNotMatch(JSON.stringify(p.body), /RIVERA|SECRET STREET/);
    // Manual entries and bill names are masked too.
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 1, description: 'Transfer to 4111.1111.1111.1111' });
    assert.equal(t.body.description, 'Transfer to ••1111');
    const patched = await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { description: 'NRIC S1234567A' });
    assert.equal(patched.body.description, 'NRIC •••••••••');
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Loan 1234 5678 9012', amount: 5, day_of_month: 3 });
    assert.equal(bill.body.description, 'Loan ••9012');
  });

  test('only the creator can show a row to more people', async () => {
    const h = await household('Widening');
    const { commit } = await importFile(h.member.agent, dbsCsv([[day(month, 1), 'POS', 'SAM ONLY', -9]]), 's.csv');
    const row = (await h.member.agent.get(`/api/budget/transactions?import_id=${commit.body.import.id}`)).body[0];
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${row.id}`, { visibility: 'family' })).status, 403);
    assert.equal((await h.child.agent.get(`/api/budget/transactions/${row.id}`)).status, 404);
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${row.id}`, { visibility: 'family' })).body.visibility, 'family');
    // Manual rows: another grown-up may hide one from the kids, not widen it again.
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 3, description: 'Gift' });
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'adults' })).status, 200);
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'family' })).status, 403);
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'family' })).status, 200);
  });

  test('over-budget live event goes to grown-ups; bill payment details follow the transaction', async () => {
    const h = await household('Nits');
    await h.admin.agent.patch(`/api/budget/categories/${h.cat('Dining').id}`, { monthly_limit: 10 });
    const childEvents = await collectEvents(h.child.agent, { timeoutMs: 1500, until: () => false });
    const memberEvents = await collectEvents(h.member.agent, { timeoutMs: 3000, until: (e) => e.type === 'budget.category.over' });
    await h.admin.agent.post('/api/budget/transactions', { amount: 50, category_id: h.cat('Dining').id, visibility: 'adults' });
    assert.ok((await memberEvents.events).some((e) => e.type === 'budget.category.over'));
    assert.ok(!(await childEvents.events).some((e) => e.type === 'budget.category.over'));
    // A family bill whose payment is an adults-only transaction: the child sees "paid", not the details.
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Rent', amount: 100, day_of_month: 1 });
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 100, date: day(month, 1), visibility: 'adults' });
    srv.db.prepare("INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id) VALUES (?, ?, ?, 'paid', ?)").run(bill.body.id, h.family.id, month, t.body.id);
    const kid = (await h.child.agent.get(`/api/budget/recurring?month=${month}`)).body.find((b) => b.id === bill.body.id);
    assert.deepEqual([kid.status, kid.transaction_id, kid.paid_amount, kid.paid_date], ['paid', null, null, null]);
    const adult = (await h.admin.agent.get(`/api/budget/recurring?month=${month}`)).body.find((b) => b.id === bill.body.id);
    assert.deepEqual([adult.transaction_id, adult.paid_amount], [t.body.id, 100]);
  });

  test('a member leaving takes their private Wall entries, rules and receipts', async () => {
    const h = await household('Leaving 2');
    const t = await h.member.agent.post('/api/budget/transactions', { amount: 77, description: 'SECRET GIFT FOR ALEX', visibility: 'private' });
    const up = await h.member.agent.upload(`/api/budget/transactions/${t.body.id}/receipt`, { file: PNG_1X1, filename: 'r.png' });
    assert.equal(up.status, 200);
    const file = path.join(srv.dir, 'uploads', up.body.receipt_url.replace('/uploads/', ''));
    assert.ok(fs.existsSync(file));
    const p = await preview(h.member.agent, dbsCsv([[day(month, 2), 'POS', 'HUSH HUSH JEWELLERS', -300]], { account: '999-99999-7777' }), 'h.csv');
    await h.member.agent.post(`/api/budget/imports/${p.body.token}/commit`, { visibility: 'private', rows: [{ row_id: 'r1', category_id: h.cat('Shopping').id }] });
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_merchant_rules WHERE family_id = ?').get(h.family.id).n, 1);
    assert.equal((await h.admin.agent.del(`/api/family/members/${h.member.user.id}`)).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(file), false);
    const rows = srv.db.prepare("SELECT summary FROM activity WHERE family_id = ? AND module = 'budget'").all(h.family.id).map((a) => a.summary).join('|');
    assert.doesNotMatch(rows, /SECRET GIFT|imported/);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_merchant_rules WHERE family_id = ?').get(h.family.id).n, 0);
  });
});

describe('functional review round 2', () => {
  test('a statement line for a bill already paid by hand is a duplicate (posted a few days later)', async () => {
    const h = await household('Bill dupes');
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Mortgage', amount: 2150, day_of_month: 1, category_id: h.cat('Housing').id, start_month: month });
    assert.equal((await h.admin.agent.post(`/api/budget/recurring/${bill.body.id}/pay`, { month, date: day(month, 1) })).status, 200);
    const p = await preview(h.admin.agent, dbsCsv([
      [day(month, 2), 'GIRO', 'MORTGAGE HOME LOAN', -2150], // the same payment, posted a day later
      [day(month, 2), 'GIRO', 'MORTGAGE HOME LOAN', -2150], // a second one in the file isn't absorbed by the same manual row
      [day(month, 9), 'GIRO', 'MORTGAGE HOME LOAN', -2150.5], // other amount
    ]), 'm.csv');
    assert.deepEqual(p.body.rows.map((r) => r.duplicate), [true, true, false]);
    const q = await preview(h.admin.agent, dbsCsv([[day(month, 2), 'GIRO', 'MORTGAGE HOME LOAN', -2150]], { account: '000-11111-2222' }), 'm2.csv');
    assert.equal(q.body.rows[0].duplicate, true);
  });

  test('imported payments mark existing bills paid; undo puts them back', async () => {
    const h = await household('Bill paid');
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Netflix', amount: 19.98, day_of_month: 7, start_month: addMonths(month, -2) });
    const prev = addMonths(month, -1);
    const { commit } = await importFile(h.admin.agent, dbsCsv([[day(prev, 8), 'UMC', 'NETFLIX.COM FOREIGN AMT USD 11.99', -19.98]]), 'n.csv');
    assert.equal(commit.status, 201);
    const status = async () => (await h.admin.agent.get(`/api/budget/recurring?month=${prev}`)).body.find((b) => b.id === bill.body.id);
    const paid = await status();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paid_amount, 19.98);
    const tx = (await h.admin.agent.get(`/api/budget/transactions?import_id=${commit.body.import.id}`)).body[0];
    assert.equal(tx.recurring_id, bill.body.id);
    assert.equal(tx.merchant, 'Netflix'); // FOREIGN AMT USD dropped from the merchant
    assert.equal((await h.admin.agent.post(`/api/budget/recurring/${bill.body.id}/pay`, { month: prev })).status, 409); // no double payment
    await h.admin.agent.del(`/api/budget/imports/${commit.body.import.id}`);
    assert.equal((await status()).status, 'overdue');
    // Manual rows have no merchant.
    assert.equal((await h.admin.agent.post('/api/budget/transactions', { amount: 1, description: 'Cash' })).body.merchant, null);
  });

  test('transfers between own accounts are flagged and left out of every total', async () => {
    const h = await household('Transfers');
    const a = await importFile(h.admin.agent, dbsCsv([
      [day(month, 1), 'GIRO', 'SALARY SAMPLECO', 3000],
      [day(month, 2), 'ICT', 'FUNDS TRANSFER TO OWN ACCOUNT', -500],
      [day(month, 3), 'FAST', 'FAST PAYMENT TO SAVINGS', -700],
    ]), 'a.csv');
    assert.deepEqual(a.preview.rows.map((r) => r.transfer), [false, true, false]);
    assert.equal(a.preview.summary.spending, 700);
    // The other account receives the 700 two days later: both sides become transfers.
    const b = await preview(h.admin.agent, dbsCsv([[day(month, 5), 'ICT', 'INCOMING FAST', 700], [day(month, 5), 'ICT', 'GIFT FROM MUM', 50]], { account: '555-66666-7777', name: 'POSB Savings Account' }), 'b.csv');
    assert.deepEqual(b.body.rows.map((r) => r.transfer), [true, false]);
    assert.equal(b.body.summary.income, 50);
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${b.body.token}/commit`, { rows: [{ row_id: 'r1', transfer: 'yes' }] })).status, 400);
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${b.body.token}/commit`, {})).status, 201);
    const s = (await h.admin.agent.get(`/api/budget/summary?month=${month}`)).body;
    assert.deepEqual([s.totals.income, s.totals.spent], [3050, 0]);
    const list = (await h.admin.agent.get(`/api/budget/transactions?month=${month}`)).body;
    assert.equal(list.filter((t) => t.transfer).length, 3); // still listed
    assert.equal((await h.admin.agent.get('/api/budget/insights')).body.months.at(-1).spending, 0);
    assert.equal((await h.admin.agent.get('/api/budget/imports')).body.find((i) => i.account_label === 'POSB ••7777').total_income, 50);
    // Manual rows: POST/PATCH accept transfer.
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 99, transfer: true });
    assert.equal(t.body.transfer, true);
    assert.equal((await h.admin.agent.get(`/api/budget/summary?month=${month}`)).body.totals.spent, 0);
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { transfer: false });
    assert.equal((await h.admin.agent.get(`/api/budget/summary?month=${month}`)).body.totals.spent, 99);
    assert.equal((await h.admin.agent.post('/api/budget/transactions', { amount: 1, transfer: 1 })).status, 400);
  });

  test('day/month order is decided per file; balance-only lines are skipped quietly', async () => {
    const h = await household('Dates');
    const us = Buffer.from(['Account Details For:,DBS Savings Account 123-45678-4821', 'Statement as at:,31 Oct 2026', '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3',
      '10/1/2026,GIRO,,5200,SALARY,ACME,', '10/4/2026,POS,91.25,,NTUC FP,,', '10/13/2026,POS,12.00,,KOPITIAM,,', '10/25/2026,POS,30.00,,SHENG SIONG,,'].join('\n'));
    const p = await preview(h.admin.agent, us, 'us.csv');
    assert.deepEqual(p.body.rows.map((r) => r.date), ['2026-10-01', '2026-10-04', '2026-10-13', '2026-10-25']);
    assert.deepEqual(p.body.warnings, []);
    const ambiguous = Buffer.from(['Account Details For:,DBS Savings Account 123-45678-4821', 'Statement as at:,31 Oct 2026', '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3',
      '10/1/2026,POS,1.00,,A,,', '10/4/2026,POS,2.00,,B,,'].join('\n'));
    const amb = await preview(h.admin.agent, ambiguous, 'a.csv');
    assert.equal(amb.body.rows.length, 2);
    assert.match(amb.body.warnings.join(' '), /day\/month or month\/day/);
    const bf = Buffer.from(['United Overseas Bank Limited', 'Account Number:,123-456-789-0', 'Statement Period:,01 Dec 2025 To 31 Jan 2026', '',
      'Transaction Date,Transaction Description,Withdrawal,Deposit,Available Balance', '31 Jan 2026,INTEREST,,0.50,"1,000.50"',
      '05 Jan 2026,NETFLIX.COM,19.98,,"1,000.00"', '30 Dec 2025,NETFLIX.COM,19.98,,"1,019.98"', '01 Dec 2025,BALANCE B/F,,,"1,039.96"'].join('\n'));
    const u = await preview(h.admin.agent, bf, 'bf.csv');
    assert.equal(u.body.rows.length, 3);
    assert.deepEqual(u.body.warnings, []);
    assert.equal(u.body.opening_balance, 1039.96);
  });

  test('recurring: two plans with one merchant, foreign-amount lines', () => {
    const it = (date, cents, desc) => ({ key: merchantKey(desc), kind: 'expense', amount_cents: cents, date, ref: `${date}-${cents}`, statement: true });
    const two = detectRecurring([it('2026-09-18', 4500, 'SINGTEL'), it('2026-09-19', 4900, 'SINGTEL'), it('2026-10-18', 4500, 'SINGTEL'), it('2026-10-19', 4900, 'SINGTEL')]);
    assert.deepEqual(two.map((g) => g.amount_cents).sort(), [4500, 4900]);
    const fx = detectRecurring([it('2025-12-28', 1599, 'Debit Card Transaction NETFLIX.COM FOREIGN AMT USD 11.99'), it('2026-01-02', 1599, 'Debit Card Transaction NETFLIX.COM')]);
    assert.equal(fx.length, 1);
    assert.equal(fx[0].key, 'NETFLIX');
    // Groceries a varying number of times a month aren't a bill.
    assert.equal(detectRecurring([it('2026-09-03', 8540, 'NTUC'), it('2026-10-04', 9125, 'NTUC'), it('2026-10-24', 6410, 'NTUC')]).length, 0);
  });

  test('balances say when they are stale; overdue goals are listed', async () => {
    const h = await household('Stale');
    await importFile(h.admin.agent, F.csv('uob'), 'uob.csv');
    // A newer UOB export without balances.
    const newer = Buffer.from(['United Overseas Bank Limited', 'Account Number:,123-456-789-0', '', 'Transaction Date,Transaction Description,Withdrawal,Deposit',
      `${dmy(day(month, 1))},COFFEE,3.00,`].join('\n'));
    await importFile(h.admin.agent, newer, 'n.csv');
    const ins = (await h.admin.agent.get('/api/budget/insights')).body;
    assert.deepEqual(ins.balances, [{ account_label: 'UOB ••7890', balance: F.statement('uob').meta.closing, as_of: '2026-10-31', statement_to: day(month, 1), stale: true }]);
    const g = await h.admin.agent.post('/api/budget/goals', { name: 'Old trip', target: 500, target_date: '2025-01-31' });
    const ins2 = (await h.admin.agent.get('/api/budget/insights')).body;
    assert.deepEqual(ins2.goals.overdue, [{ id: g.body.id, name: 'Old trip', emoji: null, target_date: '2025-01-31', left: 500 }]);
    assert.ok(!ins2.goals.items.some((x) => x.id === g.body.id));
    assert.equal(typeof ins2.goals.remaining_gap, 'number');
  });
});

describe('security review round 3', () => {
  test('a private import never links other members\' rows; links follow the bill\'s audience', async () => {
    const h = await household('Zumba');
    const m1 = addMonths(month, -3);
    const m2 = addMonths(month, -2);
    const m3 = addMonths(month, -1);
    const sam1 = await h.member.agent.post('/api/budget/transactions', { amount: 10, description: 'Zumba studio', date: day(m1, 25) });
    const sam2 = await h.member.agent.post('/api/budget/transactions', { amount: 10, description: 'Zumba studio', date: day(m2, 25) });
    // Alex has one line of their own in August too, so a bill is suggested from Alex's rows only.
    const prior = await importFile(h.admin.agent, dbsCsv([[day(m2, 5), 'POS', 'ZUMBA STUDIO', -10]]), 'p.csv', { visibility: 'private' });
    assert.equal(prior.commit.status, 201);
    const p = await preview(h.admin.agent, dbsCsv([[day(m3, 5), 'POS', 'ZUMBA STUDIO', -10]]), 'z.csv');
    const g = p.body.recurring.find((x) => x.merchant === 'Zumba Studio');
    assert.ok(g, JSON.stringify(p.body.recurring));
    assert.equal(g.months_seen, 2); // Alex's own two months, not Sam's
    const c = await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { visibility: 'private', bills: [{ group: g.group, description: 'Marriage counsellor' }] });
    assert.equal(c.status, 201);
    const bill = srv.db.prepare("SELECT * FROM budget_recurring WHERE family_id = ? AND visibility = 'private'").get(h.family.id);
    assert.ok(bill.description.startsWith('enc:v1:'));
    const linked = srv.db.prepare('SELECT id, created_by FROM budget_transactions WHERE recurring_id = ?').all(bill.id);
    assert.equal(linked.length, 2);
    assert.ok(linked.every((t) => t.created_by === h.admin.user.id));
    for (const t of [sam1, sam2]) assert.equal(srv.db.prepare('SELECT recurring_id FROM budget_transactions WHERE id = ?').get(t.body.id).recurring_id, null);
    // Nobody else can list by that bill or learn its name from duplicate detection.
    assert.equal((await h.child.agent.get(`/api/budget/transactions?recurring_id=${bill.id}`)).status, 404);
    assert.equal((await h.member.agent.get(`/api/budget/transactions?recurring_id=${bill.id}`)).status, 404);
    const probe = await preview(h.member.agent, dbsCsv([[day(m1, 25), 'POS', 'MARRIAGE COUNSELLOR', -10], [day(m2, 25), 'POS', 'DIVORCE LAWYER', -10]], { account: '999-99999-3333' }), 'mc.csv');
    assert.deepEqual(probe.body.rows.map((r) => r.duplicate), [false, false]);
    // A stale bad link (from before this fix) is hidden from people who can't see the bill.
    srv.db.prepare('UPDATE budget_transactions SET recurring_id = ? WHERE id = ?').run(bill.id, sam1.body.id);
    assert.equal((await h.child.agent.get(`/api/budget/transactions/${sam1.body.id}`)).body.recurring_id, null);
    assert.equal((await h.member.agent.get(`/api/budget/transactions?month=${m1}`)).body.find((t) => t.id === sam1.body.id).recurring_id, null);
    // Undo unlinks the earlier import's row it linked, and drops the paid months it recorded.
    await h.admin.agent.del(`/api/budget/imports/${c.body.import.id}`);
    const priorRow = srv.db.prepare('SELECT recurring_id FROM budget_transactions WHERE import_id = ?').get(prior.commit.body.import.id);
    assert.equal(priorRow.recurring_id, null);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_recurring_runs WHERE recurring_id = ?').get(bill.id).n, 0);
  });

  test('bill months: taking back an imported payment unlinks the row instead of deleting it', async () => {
    const h = await household('Release');
    const prev = addMonths(month, -1);
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Netflix', amount: 19.98, day_of_month: 7, start_month: addMonths(month, -2) });
    const { commit } = await importFile(h.admin.agent, dbsCsv([[day(prev, 8), 'UMC', 'NETFLIX.COM', -19.98]]), 'n.csv');
    const row = (await h.admin.agent.get(`/api/budget/transactions?import_id=${commit.body.import.id}`)).body[0];
    assert.equal(row.recurring_id, bill.body.id);
    assert.equal((await h.admin.agent.del(`/api/budget/recurring/${bill.body.id}/runs/${prev}`)).status, 200);
    const after = (await h.admin.agent.get(`/api/budget/transactions/${row.id}`)).body;
    assert.equal(after.recurring_id, null); // still there, just unlinked
    assert.equal(after.import_id, commit.body.import.id);
  });

  test('more masking: zero-width characters, commas, cents tails, spaced NRIC', () => {
    for (const [input, out] of [
      ['4111​1111​1111​1111', '••1111'], ['4111­1111­1111­1111', '••1111'], ['1234,5678,9012', '••9012'],
      ['4111 1111 1111 1111.00', '••1111'], ['4111 1111 1111 111.11', '••1111'], ['12.34.56.78.90', '••7890'],
      ['s 1234567 a', '•••••••••'], ['S1234567', '•••••••••'], ['G 1234567 X', '•••••••••'], ['NRIC S 1234567 A PAID', 'NRIC ••••••••• PAID'],
      ['ACCT 123,456,789.01', 'ACCT 123,456,789.01'], ['ACCT 1,234,567.89 0123', 'ACCT 1,234,567.89 0123'], ['SGD 12.30 45.60', 'SGD 12.30 45.60'],
      ['REF 2026-11-01 2345 6789', 'REF 2026-11-01 ••6789'], ['12/10/2026 12345678', '12/10/2026 ••5678'], ['ROOM 1234567 TO', 'ROOM 1234567 TO'],
    ]) assert.equal(maskDigits(input), out, input);
  });

  test('adults-only and private text is sealed at rest; older plaintext is sealed at startup', async () => {
    const h = await household('Sealing');
    const t = await h.member.agent.post('/api/budget/transactions', { amount: 77, description: 'SECRET GIFT FOR ALEX', notes: 'hidden in the attic', visibility: 'private' });
    const raw = () => srv.db.prepare('SELECT description, notes FROM budget_transactions WHERE id = ?').get(t.body.id);
    assert.ok(raw().description.startsWith('enc:v1:') && raw().notes.startsWith('enc:v1:'));
    assert.equal(t.body.description, 'SECRET GIFT FOR ALEX');
    assert.equal((await h.member.agent.get('/api/budget/transactions?q=attic&all=1')).body.length, 1);
    assert.equal((await h.member.agent.get('/api/search?q=secret%20gift')).body.results.filter((x) => x.module === 'budget').length, 1);
    assert.equal((await h.admin.agent.get('/api/search?q=secret%20gift')).body.results.filter((x) => x.module === 'budget').length, 0);
    assert.ok(!JSON.stringify((await h.member.agent.get('/api/activity')).body).includes('SECRET GIFT'));
    await h.member.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'family' });
    assert.equal(raw().description, 'SECRET GIFT FOR ALEX'); // family rows are plain (SQL search)
    await h.member.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'adults' });
    assert.ok(raw().description.startsWith('enc:v1:'));
    // Legacy plaintext: rows/bills written before sealing are sealed when the server starts.
    const legacyTx = Number(srv.db.prepare("INSERT INTO budget_transactions (family_id, kind, amount_cents, description, notes, date, created_by, visibility) VALUES (?, 'expense', 500, 'LEGACY-PLAINTEXT-TX', 'LEGACY-NOTE', ?, ?, 'adults')")
      .run(h.family.id, day(month, 1), h.admin.user.id).lastInsertRowid);
    const legacyBill = Number(srv.db.prepare("INSERT INTO budget_recurring (family_id, kind, description, amount_cents, day_of_month, start_month, created_by, visibility) VALUES (?, 'expense', 'LEGACY-PLAINTEXT-BILL', 500, 3, ?, ?, 'private')")
      .run(h.family.id, month, h.admin.user.id).lastInsertRowid);
    srv.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const again = await startServer({ dbPath: path.join(srv.dir, 'test.db'), uploadDir: path.join(srv.dir, 'uploads') });
    try {
      assert.ok(srv.db.prepare('SELECT description FROM budget_transactions WHERE id = ?').get(legacyTx).description.startsWith('enc:v1:'));
      assert.ok(srv.db.prepare('SELECT description FROM budget_recurring WHERE id = ?').get(legacyBill).description.startsWith('enc:v1:'));
      const file = Buffer.concat(walk(srv.dir).filter((f) => /test\.db/.test(f)).map((f) => fs.readFileSync(f)));
      for (const needle of ['LEGACY-PLAINTEXT-TX', 'LEGACY-NOTE', 'LEGACY-PLAINTEXT-BILL']) assert.ok(!file.includes(Buffer.from(needle)), `${needle} left in the file`);
    } finally {
      await again.close();
    }
    const tx = (await h.admin.agent.get(`/api/budget/transactions/${legacyTx}`)).body;
    assert.deepEqual([tx.description, tx.notes], ['LEGACY-PLAINTEXT-TX', 'LEGACY-NOTE']);
  });

  test("other grown-ups may re-file an imported row, not change its wording or transfer flag", async () => {
    const h = await household('Imported edits');
    const { commit } = await importFile(h.member.agent, dbsCsv([[day(month, 1), 'POS', 'SAM SHOP', -9]]), 's.csv');
    const row = (await h.member.agent.get(`/api/budget/transactions?import_id=${commit.body.import.id}`)).body[0];
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${row.id}`, { description: 'Renamed' })).status, 403);
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${row.id}`, { transfer: true })).status, 403);
    assert.equal((await h.admin.agent.patch(`/api/budget/transactions/${row.id}`, { category_id: h.cat('Shopping').id, description: row.description })).status, 200);
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${row.id}`, { description: 'Renamed', transfer: true })).status, 200);
  });

  test('the parser process may read only its own code and pdf.js', async () => {
    const { parserFlags } = await import('../src/modules/budget/import.js');
    const { execFileSync } = await import('node:child_process');
    const keyFile = path.join(srv.dir, 'hearth.key');
    assert.ok(fs.existsSync(keyFile));
    const run = (code) => {
      try {
        return execFileSync(process.execPath, [...parserFlags(), '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (err) {
        return `ERR ${/ERR_ACCESS_DENIED/.test(err.stderr) ? 'ERR_ACCESS_DENIED' : err.stderr.slice(0, 200)}`;
      }
    };
    assert.equal(run(`require('fs').readFileSync(${JSON.stringify(keyFile)})`), 'ERR ERR_ACCESS_DENIED');
    assert.equal(run(`require('fs').writeFileSync(${JSON.stringify(path.join(srv.dir, 'x'))}, 'x')`), 'ERR ERR_ACCESS_DENIED');
    assert.equal(run("require('child_process').execSync('true')"), 'ERR ERR_ACCESS_DENIED');
    assert.equal(run(`console.log(require('fs').readFileSync(${JSON.stringify(fileURLToPath(new URL('../src/modules/budget/import.js', import.meta.url)))}).length > 0)`), 'true');
    // …and statements still parse (PDF on a worker thread inside it).
    assert.equal((await preview((await household('Perm')).admin.agent, F.pdf('uob', { password: F.PDF_PASSWORD }), 'u.pdf', { password: F.PDF_PASSWORD })).status, 200);
  });

  test('the holder\'s name in any word order, and from an unlabelled PDF header', async () => {
    const h = await household('Holder');
    const csvFile = Buffer.from(['Account Details For:,DBS Multiplier Account 123-45678-4821', 'Name:,ALEX RIVERA', '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3',
      `${dmy(day(month, 1))},ICT,16.00,,RIVERA ALEX PAYNOW,,`, `${dmy(day(month, 2))},ICT,17.00,,TO ALEX TAN,,`].join('\n'));
    assert.deepEqual((await preview(h.admin.agent, csvFile, 'h.csv')).body.rows.map((r) => r.description), ['ICT (you) PAYNOW', 'ICT TO ALEX TAN']);
    // DBS layout (as in the open-source parser's fixture): the name heads the address block, unlabelled.
    const { makePdf } = await import('./fixtures/statements/pdf.js');
    const pdf = makePdf([[[40, 800, 'DBS Bank Ltd'], [40, 788, '12 Marina Boulevard, Singapore 018982'], [60, 760, 'MARCUS LIM WEI'], [60, 748, '88 KESTREL AVENUE'],
      [60, 736, 'SINGAPORE 559120'], [400, 716, `As at ${dmy(day(month, 20))}`], [40, 700, 'Details of Your DBS Savings Plus Account'], [380, 700, 'Account No.: 098-7-654321'],
      [40, 680, 'DATE'], [110, 680, 'DETAILS OF TRANSACTIONS'], [330, 680, 'WITHDRAWAL($)'], [420, 680, 'DEPOSIT($)'], [510, 680, 'BALANCE($)'],
      [110, 664, 'Balance Brought Forward'], [520, 664, '2,000.00'],
      [40, 648, `${day(month, 2).slice(8)} ${dmy(day(month, 2)).slice(3, 6)}`], [110, 648, 'Funds Transfer'], [355, 648, '210.00'], [520, 648, '1,790.00'],
      [110, 637, 'TO LIM WEI MARCUS'],
    ]]);
    const p = await preview(h.admin.agent, pdf, 'd.pdf');
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.rows[0].description, 'Funds Transfer TO (you)');
    assert.doesNotMatch(JSON.stringify(p.body), /MARCUS|KESTREL/);
  });
});

describe('functional review round 3', () => {
  test('pairing: shown in the preview, can be declined, and undo clears the other side', async () => {
    const h = await household('Pairs');
    const dbs = await importFile(h.admin.agent, F.pairCsv('dbs'), 'dbs-pair.csv');
    assert.equal(dbs.commit.status, 201);
    const dbsRow = () => srv.db.prepare("SELECT transfer, transfer_by_import FROM budget_transactions WHERE import_id = ? AND amount_cents = 150000").get(dbs.commit.body.import.id);
    assert.equal(dbsRow().transfer, 0);
    const p = await preview(h.admin.agent, F.pairCsv('uob'), 'uob-pair.csv');
    const row = p.body.rows.find((r) => r.amount === 1500);
    assert.equal(row.transfer, true);
    assert.deepEqual(row.pair, { account_label: 'DBS ••4821', date: '2026-10-10', amount: -1500, description: 'ICT FUNDS TRANSFER IBANKING' });
    assert.equal(p.body.rows.find((r) => r.amount === 4.2).pair, null);
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { rows: [{ row_id: row.row_id, pair: true }] })).status, 400);
    // Declined: this row is a transfer, the DBS one stays as it was.
    const declined = await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { rows: [{ row_id: row.row_id, pair: false }] });
    assert.equal(declined.status, 201);
    assert.equal(dbsRow().transfer, 0);
    await h.admin.agent.del(`/api/budget/imports/${declined.body.import.id}`);
    // Accepted, then undone: the DBS row counts again.
    const again = await importFile(h.admin.agent, F.pairCsv('uob'), 'uob-pair.csv');
    assert.equal(dbsRow().transfer, 1);
    assert.equal(dbsRow().transfer_by_import, again.commit.body.import.id);
    assert.equal((await h.admin.agent.get('/api/budget/summary?month=2026-10')).body.totals.spent, 12.7);
    await h.admin.agent.del(`/api/budget/imports/${again.commit.body.import.id}`);
    assert.deepEqual({ ...dbsRow() }, { transfer: 0, transfer_by_import: null });
    // No transfer-like word on either side: equal opposite amounts are not paired.
    const salary = dbsCsv([[day(month, 1), 'GIRO', 'SALARY SAMPLECO', 2000]], { account: '000-11122-5555' });
    await importFile(h.admin.agent, salary, 's.csv');
    const rent = await preview(h.admin.agent, dbsCsv([[day(month, 2), 'POS', 'RENT SAMPLE PROPERTY', -2000]], { account: '000-11122-6666' }), 'r.csv');
    assert.deepEqual([rent.body.rows[0].transfer, rent.body.rows[0].pair], [false, null]);
  });

  test("bills from an import are 'expected' until a statement covers them", async () => {
    const h = await household('Expected');
    const [m2, m1] = [addMonths(month, -2), addMonths(month, -1)];
    const lastDay = (m) => day(m, daysInMonth(m));
    const statement = (rows, asAt) => Buffer.from(['Account Details For:,DBS Multiplier Account 123-45678-4821', `Statement as at:,${dmy(asAt)}`, '',
      'Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Transaction Ref2,Transaction Ref3',
      ...rows.map(([d, desc, amt]) => `${dmy(d)},UMC,${amt.toFixed(2)},,${desc},,`)].join('\n'));
    const p = await preview(h.admin.agent, statement([[day(m2, 28), 'GYM SAMPLE', 50], [day(m1, 28), 'GYM SAMPLE', 50]], lastDay(m1)), 'g.csv');
    const g = p.body.recurring.find((x) => x.merchant === 'Gym Sample');
    assert.ok(g, JSON.stringify(p.body.recurring));
    assert.equal((await h.admin.agent.post(`/api/budget/imports/${p.body.token}/commit`, { bills: [{ group: g.group }] })).body.bills_created, 1);
    const status = async (m) => (await h.admin.agent.get(`/api/budget/recurring?month=${m}`)).body.find((b) => b.description === 'Gym Sample')?.status;
    assert.equal(await status(m1), 'paid');
    assert.equal(await status(month), 'expected'); // due on the 28th, after the statement's end — never "overdue"
    assert.equal(await status(addMonths(month, 1)), 'expected');
    assert.equal((await h.admin.agent.get('/api/budget/badge')).body.bills_due, 0);
    // A statement covering this month's due date: back to the usual statuses.
    await importFile(h.admin.agent, statement([[day(month, 2), 'SAMPLE BAKERY', 3]], lastDay(month)), 'n.csv');
    assert.ok(['upcoming', 'due_today', 'overdue'].includes(await status(month)));
    assert.equal(await status(addMonths(month, 1)), 'expected');
  });
});

describe('review round 4', () => {
  test("bill events: the payment's details only reach people who can see that payment", async () => {
    const h = await household('Bill events');
    const prev = addMonths(month, -1);
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Netflix', amount: 19.98, day_of_month: 7, start_month: addMonths(month, -2) });
    await importFile(h.admin.agent, dbsCsv([[day(prev, 8), 'UMC', 'NETFLIX.COM', -19.98]]), 'n.csv'); // adults-only row pays the family bill
    const isBill = (e) => e.type === 'budget.bill.updated' && e.payload?.id === bill.body.id;
    const kid = await collectEvents(h.child.agent, { timeoutMs: 4000, until: isBill });
    const sam = await collectEvents(h.member.agent, { timeoutMs: 4000, until: isBill });
    assert.equal((await h.admin.agent.patch(`/api/budget/recurring/${bill.body.id}?month=${prev}`, { description: 'Netflix family' })).status, 200);
    const k = (await kid.events).find(isBill).payload;
    const m = (await sam.events).find(isBill).payload;
    assert.deepEqual([k.status, k.transaction_id, k.paid_amount, k.paid_date], ['paid', null, null, null]);
    assert.equal(m.paid_amount, 19.98);
    assert.ok(m.transaction_id);
    // Taking the month back: the same split.
    const kid2 = await collectEvents(h.child.agent, { timeoutMs: 4000, until: isBill });
    await h.admin.agent.del(`/api/budget/recurring/${bill.body.id}/runs/${prev}`);
    const k2 = (await kid2.events).find(isBill).payload;
    assert.equal(k2.transaction_id, null);
  });

  test('sealing a row on a visibility change leaves no plaintext in the WAL', async () => {
    const h = await household('WAL');
    srv.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 5, description: 'WALMARKER-PLAIN', notes: 'WALNOTE-PLAIN' });
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'adults' });
    const file = Buffer.concat(walk(srv.dir).filter((f) => /test\.db/.test(f)).map((f) => fs.readFileSync(f)));
    assert.ok(!file.includes(Buffer.from('WALMARKER-PLAIN')) && !file.includes(Buffer.from('WALNOTE-PLAIN')));
  });

  test('PDF import works when node_modules is a symlink; the self-test says so', async () => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-link-'));
    try {
      const dir = path.join(T, 'app', 'server', 'src', 'modules', 'budget');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(fileURLToPath(new URL('../src/modules/budget/import.js', import.meta.url)), path.join(dir, 'import.js'));
      fs.writeFileSync(path.join(T, 'app', 'server', 'package.json'), '{"type":"module"}');
      fs.symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(T, 'app', 'node_modules'), 'dir');
      const copy = await import(new URL(`file://${path.join(dir, 'import.js')}`).href);
      assert.equal(await copy.pdfImportSelfTest(), true);
      assert.equal((await copy.parseInWorker(F.pdf('dbs'), { filename: 'd.pdf' })).rows.length, F.statement('dbs').rows.length);
      assert.ok(copy.parserFlags().some((f) => f === `--allow-fs-read=${path.join(T, 'app', 'node_modules', 'pdfjs-dist')}`));
    } finally {
      fs.rmSync(T, { recursive: true, force: true });
    }
  });

  test('links the audience rule rejects are removed at startup', async () => {
    const h = await household('Old links');
    const sam = await h.member.agent.post('/api/budget/transactions', { amount: 10, description: 'Zumba studio', date: day(month, 2) });
    const bill = Number(srv.db.prepare("INSERT INTO budget_recurring (family_id, kind, description, amount_cents, day_of_month, start_month, created_by, visibility) VALUES (?, 'expense', ?, 1000, 2, ?, ?, 'private')")
      .run(h.family.id, srv.ctx.box.seal('Secret bill'), month, h.admin.user.id).lastInsertRowid);
    srv.db.prepare('UPDATE budget_transactions SET recurring_id = ? WHERE id = ?').run(bill, sam.body.id);
    srv.db.prepare("INSERT INTO budget_recurring_runs (recurring_id, family_id, month, status, transaction_id) VALUES (?, ?, ?, 'paid', ?)").run(bill, h.family.id, month, sam.body.id);
    const again = await startServer({ dbPath: path.join(srv.dir, 'test.db'), uploadDir: path.join(srv.dir, 'uploads') });
    try {
      assert.equal(srv.db.prepare('SELECT recurring_id FROM budget_transactions WHERE id = ?').get(sam.body.id).recurring_id, null);
      assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM budget_recurring_runs WHERE recurring_id = ?').get(bill).n, 0);
    } finally {
      await again.close();
    }
  });

  test('masking: semicolons; words before 7 digits are left alone', () => {
    assert.equal(maskDigits('ACCT 1234 ; 5678 ; 9012'), 'ACCT ••9012');
    assert.equal(maskDigits('1234;5678;9012'), '••9012');
    assert.equal(maskDigits('STAN 1234567 X'), 'STAN 1234567 X');
  });

  test('lines naming another of the banks are likely transfers; the closest pair wins', async () => {
    const h = await household('Bank names');
    const p = await preview(h.admin.agent, dbsCsv([
      [day(month, 1), 'ICT', 'FAST TRANSFER TO UOB A/C', -100], [day(month, 1), 'ICT', 'FUNDS TO POSB A/C', -50], [day(month, 1), 'ICT', 'TO DBS A/C 1234', -20],
      [day(month, 2), 'ICT', 'PAYNOW TO JOHN TAN', -30],
    ]), 'b.csv');
    assert.deepEqual(p.body.rows.map((r) => r.transfer), [true, false, false, false]); // POSB/DBS is this bank
    const uob = Buffer.from(['United Overseas Bank Limited', 'Account Number:,123-456-789-0', '', 'Transaction Date,Transaction Description,Withdrawal,Deposit',
      `${dmy(day(month, 2))},FUNDS TRANSFER FROM DBS,,100.00`].join('\n'));
    assert.equal((await preview(h.admin.agent, uob, 'u.csv')).body.rows[0].transfer, true);
    // Two possible other halves: the closer date wins; on the same day, the one naming this bank.
    const q = await importFile(h.admin.agent, dbsCsv([
      [day(month, 10), 'ICT', 'FAST TRANSFER', -700], [day(month, 12), 'ICT', 'FAST PAYMENT X', -700],
      [day(month, 20), 'ICT', 'FAST TRANSFER', -900], [day(month, 20), 'ICT', 'FAST TRANSFER UOB', -900],
    ], { account: '000-11122-8888' }), 'q.csv');
    assert.equal(q.commit.status, 201);
    const other = await preview(h.admin.agent, Buffer.from(['United Overseas Bank Limited', 'Account Number:,555-666-777-1', '',
      'Transaction Date,Transaction Description,Withdrawal,Deposit', `${dmy(day(month, 13))},FAST TRANSFER IN,,700.00`, `${dmy(day(month, 21))},FAST TRANSFER IN,,900.00`].join('\n')), 'o.csv');
    assert.deepEqual(other.body.rows.map((r) => [r.pair?.date, r.pair?.description]), [[day(month, 12), 'ICT FAST PAYMENT X'], [day(month, 20), 'ICT FAST TRANSFER UOB']]);
  });
});
