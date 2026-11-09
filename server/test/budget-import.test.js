// Bank statement import (DBS/POSB, UOB) + money insights. Fixtures: test/fixtures/statements (synthetic).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, familyFixture, registerUser, collectEvents } from './helpers.js';
import * as F from './fixtures/statements/index.js';
import { addMonths, autoAmount, dateKey, monthOf } from '../src/modules/budget/lib.js';
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
    assert.ok(!(await h.child.agent.get('/api/activity')).body.some((a) => /Secret gift/.test(a.summary)));
    assert.ok((await h.member.agent.get('/api/activity')).body.some((a) => /Secret gift/.test(a.summary)));
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'private' });
    assert.equal((await h.member.agent.get(`/api/budget/transactions/${t.body.id}`)).status, 404);
    assert.ok(!(await h.member.agent.get('/api/activity')).body.some((a) => /Secret gift/.test(a.summary)));
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { visibility: 'family' });
    assert.ok((await h.child.agent.get('/api/activity')).body.some((a) => /Secret gift/.test(a.summary)));
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
    const bills = srv.db.prepare("SELECT * FROM budget_recurring WHERE family_id = ? AND description LIKE 'Netflix%'").all(h.family.id);
    assert.equal(bills.length, 1);
    assert.equal(bills[0].description, 'Netflix ••7890');
    assert.equal(bills[0].visibility, 'adults');
    assert.equal(bills[0].auto_create, 0);
    assert.equal(bills[0].start_month, '2026-10');
    // October is paid by the imported payment; no extra transaction was created.
    const oct = (await h.admin.agent.get('/api/budget/recurring?month=2026-10')).body.find((b) => b.id === bills[0].id);
    assert.equal(oct.status, 'paid');
    assert.equal(oct.paid_amount, 19.98);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND recurring_id = ?").get(h.family.id, bills[0].id).n, 1);
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
      await add({ amount: 400, date: day(m, 12), description: 'Dinner out', category_id: h.cat('Dining').id });
    }
    await add({ amount: 900, date: day(month, 1), description: 'Dinner out', category_id: h.cat('Dining').id });
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
    assert.equal(ins.months[3].spending, 900);
    assert.equal(ins.avg_income, 5000);
    assert.equal(ins.avg_spending, 1400);
    assert.equal(ins.avg_surplus, 3600);
    const dining = ins.categories.find((c) => c.name === 'Dining');
    assert.deepEqual([dining.avg, dining.this_month, dining.change_pct], [400, 900, 125]);
    assert.deepEqual(ins.spikes.map((s) => s.name), ['Dining']);
    assert.equal(ins.categories[0].name, 'Groceries'); // biggest average first
    assert.equal(ins.merchants[0].merchant, 'Ntuc Fairprice');
    assert.equal(ins.merchants[0].total, 3000);
    const monthly = autoAmount(5_000_000, month, target) / 100;
    assert.equal(ins.goals.needed_monthly, monthly);
    assert.equal(ins.goals.items[0].id, goal.body.id);
    assert.equal(ins.goals.undated, 1);
    assert.equal(ins.goals.status, 'short');
    assert.equal(ins.goals.shortfall, Math.round((monthly - 3600) * 100) / 100);
    const tips = ins.goals.suggestions.join('\n');
    assert.match(tips, /Move 🏠 House from .+ to .+ frees up/);
    assert.match(tips, /less on Dining/);
    assert.match(tips, /Dining is 125% above usual/);
    assert.match(tips, /1 goal has no target date/);
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
    assert.deepEqual(ins2.balances, [{ account_label: 'DBS ••4821', balance: F.statement('dbs').meta.closing, as_of: '2026-10-31' }]);
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
