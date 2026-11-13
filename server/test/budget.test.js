import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';
import { autoContribute, sweep } from '../src/modules/budget.js';
import { addMonths, autoAmount, billStatus, dateKey, dueDate, generateDue, monthLabel, monthOf, toCents } from '../src/modules/budget/lib.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const today = dateKey();
const month = monthOf(today);

/** Family with admin, member and a child (all with agents). */
async function household(name = 'Budget Fam') {
  const f = await familyFixture(srv, name);
  const child = await registerUser(srv, { name: 'Kiddo' });
  await child.agent.post('/api/families/join', { invite_code: f.family.invite_code });
  const r = await f.admin.agent.patch(`/api/family/members/${child.user.id}`, { role: 'child' });
  assert.equal(r.status, 200);
  const cats = (await f.admin.agent.get('/api/budget/categories')).body;
  const cat = (n) => cats.find((c) => c.name === n);
  return { ...f, child, cats, cat };
}

describe('helpers', () => {
  test('toCents parses and validates money', () => {
    assert.equal(toCents(12.5), 1250);
    assert.equal(toCents('0.1'), 10);
    assert.equal(toCents(19.99), 1999);
    assert.throws(() => toCents(-1), /positive/);
    assert.throws(() => toCents(0), /more than zero/);
    assert.throws(() => toCents(1.234), /2 decimals/);
    assert.throws(() => toCents('abc'), /number/);
    assert.equal(toCents(-5, { allowNegative: true }), -500);
  });
  test('month math clamps due dates', () => {
    assert.equal(dueDate('2026-02', 31), '2026-02-28');
    assert.equal(dueDate('2028-02', 30), '2028-02-29');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    const bill = { start_month: '2026-01', end_month: null, day_of_month: 10 };
    assert.equal(billStatus(bill, '2026-03', null, '2026-03-11'), 'overdue');
    assert.equal(billStatus(bill, '2026-03', null, '2026-03-10'), 'due_today');
    assert.equal(billStatus(bill, '2026-03', null, '2026-03-01'), 'upcoming');
    assert.equal(billStatus(bill, '2025-12', null, '2026-03-01'), 'inactive');
    assert.equal(billStatus(bill, '2026-03', { status: 'paid', transaction_id: 3 }), 'paid');
    assert.equal(billStatus(bill, '2026-03', { status: 'skipped', transaction_id: null }), 'skipped');
  });
});

describe('categories', () => {
  test('defaults are created once and can be customised', async () => {
    const h = await household('Cats');
    const names = h.cats.map((c) => c.name);
    for (const n of ['Groceries', 'Housing', 'Utilities', 'Transport', 'Kids', 'Health', 'Dining', 'Entertainment', 'Shopping', 'Savings', 'Other', 'Salary']) {
      assert.ok(names.includes(n), `missing default ${n}`);
    }
    const created = await h.admin.agent.post('/api/budget/categories', { name: 'Pets', icon: 'dog', color: '#12a594', kind: 'expense', monthly_limit: 80 });
    assert.equal(created.status, 201);
    assert.equal(created.body.color, '#12A594');
    assert.equal(created.body.monthly_limit, 80);
    assert.equal((await h.admin.agent.post('/api/budget/categories', { name: 'pets' })).status, 409);
    assert.equal((await h.admin.agent.post('/api/budget/categories', { name: 'X', icon: 'nope' })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/categories', { name: 'X', color: 'red' })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/categories', { name: 'Bonus', kind: 'income', monthly_limit: 5 })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/categories', { name: '' })).status, 400);

    const patched = await h.member.agent.patch(`/api/budget/categories/${created.body.id}`, { monthly_limit: null, name: 'Pet care' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.monthly_limit, null);
    assert.equal(patched.body.name, 'Pet care');
    assert.equal((await h.admin.agent.patch(`/api/budget/categories/${created.body.id}`, { kind: 'income' })).status, 400);

    // Children can't manage categories.
    assert.equal((await h.child.agent.post('/api/budget/categories', { name: 'Toys' })).status, 403);
    assert.equal((await h.child.agent.patch(`/api/budget/categories/${created.body.id}`, { name: 'Toys' })).status, 403);
    assert.equal((await h.child.agent.del(`/api/budget/categories/${created.body.id}`)).status, 403);

    // Deleting keeps transactions (moved or uncategorized).
    const tx = await h.admin.agent.post('/api/budget/transactions', { amount: 20, category_id: created.body.id, description: 'Dog food' });
    assert.equal((await h.admin.agent.del(`/api/budget/categories/${created.body.id}`, { body: { move_to: h.cat('Other').id } })).status, 200);
    const moved = await h.admin.agent.get(`/api/budget/transactions/${tx.body.id}`);
    assert.equal(moved.body.category_id, h.cat('Other').id);
    const again = (await h.admin.agent.get('/api/budget/categories')).body;
    assert.equal(again.length, h.cats.length, 'defaults are not re-created');
  });

  test('categories are family-scoped', async () => {
    const a = await household('Cat A');
    const b = await household('Cat B');
    const id = a.cat('Dining').id;
    assert.equal((await b.admin.agent.patch(`/api/budget/categories/${id}`, { name: 'Hack' })).status, 404);
    assert.equal((await b.admin.agent.del(`/api/budget/categories/${id}`)).status, 404);
    assert.equal((await b.admin.agent.post('/api/budget/transactions', { amount: 5, category_id: id })).status, 404);
  });
});

describe('transactions', () => {
  test('CRUD, validation and permissions', async () => {
    const h = await household('Tx');
    const groceries = h.cat('Groceries');
    const c = await h.admin.agent.post('/api/budget/transactions', {
      kind: 'expense', amount: '42.10', category_id: groceries.id, description: "Trader Joe's", date: today, paid_by: h.member.user.id, notes: 'weekly',
    });
    assert.equal(c.status, 201);
    assert.equal(c.body.amount, 42.1);
    assert.equal(c.body.category.name, 'Groceries');
    assert.equal(c.body.paid_by, h.member.user.id);
    assert.equal(c.body.created_by, h.admin.user.id);

    // Validation
    const bad = [
      { amount: -3 }, { amount: 0 }, { amount: 1.005 }, { amount: 'x' }, {},
      { amount: 5, date: '2026-02-31' }, { amount: 5, date: '1969-12-31' }, { amount: 5, date: '2101-01-01' }, { amount: 5, kind: 'refund' },
      { amount: 5, category_id: h.cat('Salary').id }, // income category on an expense
      { amount: 5, description: 'x'.repeat(141) },
    ];
    for (const body of bad) assert.equal((await h.admin.agent.post('/api/budget/transactions', body)).status, 400, JSON.stringify(body));
    const outsider = await registerUser(srv, { name: 'Out' });
    assert.equal((await h.admin.agent.post('/api/budget/transactions', { amount: 5, paid_by: outsider.user.id })).status, 400);

    // Defaults: paid_by = me, date = today, kind = expense
    const d = await h.member.agent.post('/api/budget/transactions', { amount: 3 });
    assert.equal(d.body.paid_by, h.member.user.id);
    assert.equal(d.body.date, today);
    assert.equal(d.body.kind, 'expense');

    // Update; switching kind drops a mismatched category
    const u = await h.admin.agent.patch(`/api/budget/transactions/${c.body.id}`, { amount: 50, description: 'TJ' });
    assert.equal(u.body.amount, 50);
    assert.equal(u.body.description, 'TJ');
    const k = await h.admin.agent.patch(`/api/budget/transactions/${c.body.id}`, { kind: 'income' });
    assert.equal(k.body.kind, 'income');
    assert.equal(k.body.category_id, null);

    // Child: can add own spending, not for others, can't edit others' transactions
    const kid = await h.child.agent.post('/api/budget/transactions', { amount: 4.5, description: 'Candy' });
    assert.equal(kid.status, 201);
    assert.equal(kid.body.paid_by, h.child.user.id);
    assert.equal((await h.child.agent.post('/api/budget/transactions', { amount: 4.5, paid_by: h.admin.user.id })).status, 403);
    assert.equal((await h.child.agent.post('/api/budget/transactions', { amount: 5000, kind: 'income' })).status, 403, 'kids record expenses only');
    assert.equal((await h.child.agent.patch(`/api/budget/transactions/${kid.body.id}`, { kind: 'income' })).status, 403);
    assert.equal((await h.child.agent.patch(`/api/budget/transactions/${c.body.id}`, { amount: 1 })).status, 403);
    assert.equal((await h.child.agent.del(`/api/budget/transactions/${c.body.id}`)).status, 403);
    assert.equal((await h.child.agent.patch(`/api/budget/transactions/${kid.body.id}`, { amount: 5 })).status, 200);
    // Adults can edit anyone's
    assert.equal((await h.member.agent.patch(`/api/budget/transactions/${kid.body.id}`, { notes: 'ok' })).status, 200);

    // Soft delete + restore (undo)
    assert.equal((await h.admin.agent.del(`/api/budget/transactions/${d.body.id}`)).status, 200);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions/${d.body.id}`)).status, 404);
    const restored = await h.admin.agent.post(`/api/budget/transactions/${d.body.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.id, d.body.id);
    assert.equal((await h.admin.agent.post(`/api/budget/transactions/${d.body.id}/restore`)).status, 404);
  });

  test('list filters and search', async () => {
    const h = await household('Filters');
    const prevMonth = addMonths(month, -1);
    const add = (agent, body) => agent.post('/api/budget/transactions', body);
    await add(h.admin.agent, { amount: 10, category_id: h.cat('Dining').id, description: 'Pizza night' });
    await add(h.member.agent, { amount: 20, category_id: h.cat('Groceries').id, description: 'Costco' });
    await add(h.member.agent, { amount: 1000, kind: 'income', category_id: h.cat('Salary').id, description: 'Paycheck' });
    await add(h.admin.agent, { amount: 30, description: 'Old pizza', date: `${prevMonth}-10` });

    const all = (await h.admin.agent.get(`/api/budget/transactions?month=${month}`)).body;
    assert.equal(all.length, 3);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&kind=income`)).body.length, 1);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&category_id=${h.cat('Dining').id}`)).body.length, 1);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&paid_by=${h.member.user.id}`)).body.length, 2);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&q=pizza`)).body.length, 1);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&q=pizza&all=1`)).body.length, 2);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&q=groc`)).body.length, 1, 'matches category name');
    assert.equal((await h.admin.agent.get('/api/budget/transactions?month=2026-13')).status, 400);

    const s = (await h.admin.agent.get(`/api/budget/summary?month=${month}`)).body;
    assert.equal(s.totals.income, 1000);
    assert.equal(s.totals.spent, 30);
    assert.equal(s.totals.balance, 970);
    assert.equal(s.totals.prev_spent, 30);
    assert.equal(s.trend.length, 6);
    assert.equal(s.trend[5].month, month);
    assert.equal(s.trend[4].spent, 30);
    assert.equal(s.categories.find((c) => c.name === 'Dining').total, 10);
    assert.equal(s.by_member.find((m) => m.user_id === h.member.user.id).spent, 20);
    assert.equal(s.currency, 'USD');

    const search = await h.admin.agent.get('/api/search?q=pizza');
    assert.ok(search.body.results.some((r) => r.module === 'budget' && r.title === 'Pizza night'));
  });

  test('keyset pagination pages through every row', async () => {
    const h = await household('Paging');
    for (let i = 0; i < 7; i++) await h.admin.agent.post('/api/budget/transactions', { amount: i + 1, description: `P${i}` });
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard++) {
      const r = await h.admin.agent.get(`/api/budget/transactions?month=${month}&page=1&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((t) => t.id));
      cursor = r.body.next_cursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    assert.equal((await h.admin.agent.get('/api/budget/transactions?cursor=nope')).status, 400);
  });

  test('client local date drives bill status; X-Timezone is honoured', async () => {
    const h = await household('Local day');
    const dom = new Date().getDate();
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Rent', amount: 10, day_of_month: dom });
    assert.equal(bill.body.status, 'due_today');
    // A client a day behind (or, late in the UTC day, ahead): the server only accepts a ?today within ~36 h
    // of now, and the test's local "yesterday" falls outside that in a US evening (UTC is already tomorrow).
    const hoursIn = (Date.now() - Date.parse(`${today}T00:00:00Z`)) / 3600e3;
    const behind = hoursIn <= 24;
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (behind ? -1 : 1));
    const other = d.toISOString().slice(0, 10);
    const list = (await h.admin.agent.get(`/api/budget/recurring?month=${month}&today=${other}`)).body;
    assert.equal(list.find((b) => b.id === bill.body.id).status, behind ? 'upcoming' : 'overdue');
    if (behind) assert.equal((await h.admin.agent.get(`/api/budget/badge?today=${other}`)).body.bills_due, 0);
    // A far-off "today" is ignored (falls back to the family's day).
    assert.equal((await h.admin.agent.get(`/api/budget/recurring?month=${month}&today=2001-01-01`)).body.find((b) => b.id === bill.body.id).status, 'due_today');
    // Without ?today the user's X-Timezone decides (UTC+14 is often already "tomorrow").
    const zone = 'Pacific/Kiritimati';
    const zoneToday = srv.ctx.time.dateIn(zone);
    const due = dueDate(month, dom);
    const expected = due < zoneToday ? 'overdue' : due === zoneToday ? 'due_today' : 'upcoming';
    const viaHeader = (await h.admin.agent.get(`/api/budget/recurring?month=${month}`, { headers: { 'x-timezone': zone } })).body;
    assert.equal(viaHeader.find((b) => b.id === bill.body.id).status, expected);
  });

  test('a bill payment cannot be restored once the month was paid again', async () => {
    const h = await household('Restore');
    const bill = await h.admin.agent.post('/api/budget/recurring', { description: 'Gym', amount: 40, day_of_month: 1 });
    const first = await h.admin.agent.post(`/api/budget/recurring/${bill.body.id}/pay`, { month });
    // Deleting the payment and restoring it (nothing else happened) works.
    await h.admin.agent.del(`/api/budget/transactions/${first.body.transaction_id}`);
    assert.equal((await h.admin.agent.get(`/api/budget/recurring?month=${month}`)).body.find((b) => b.id === bill.body.id).status !== 'paid', true);
    assert.equal((await h.admin.agent.post(`/api/budget/transactions/${first.body.transaction_id}/restore`)).status, 200);
    // Delete again, re-pay, then restoring the old one would double it → refused.
    await h.admin.agent.del(`/api/budget/transactions/${first.body.transaction_id}`);
    const second = await h.admin.agent.post(`/api/budget/recurring/${bill.body.id}/pay`, { month });
    assert.notEqual(second.body.transaction_id, first.body.transaction_id);
    assert.equal((await h.admin.agent.post(`/api/budget/transactions/${first.body.transaction_id}/restore`)).status, 409);
    const txs = (await h.admin.agent.get(`/api/budget/transactions?month=${month}&recurring_id=${bill.body.id}`)).body;
    assert.equal(txs.length, 1);
  });

  test('transactions are family-scoped', async () => {
    const a = await household('Scope A');
    const b = await household('Scope B');
    const t = await a.admin.agent.post('/api/budget/transactions', { amount: 12, description: 'Secret' });
    const id = t.body.id;
    assert.equal((await b.admin.agent.get(`/api/budget/transactions/${id}`)).status, 404);
    assert.equal((await b.admin.agent.patch(`/api/budget/transactions/${id}`, { amount: 1 })).status, 404);
    assert.equal((await b.admin.agent.del(`/api/budget/transactions/${id}`)).status, 404);
    assert.equal((await b.admin.agent.upload(`/api/budget/transactions/${id}/receipt`, { file: PNG_1X1 })).status, 404);
    assert.ok(!(await b.admin.agent.get(`/api/budget/transactions?month=${month}`)).body.some((x) => x.id === id));
    assert.ok(!(await b.admin.agent.get('/api/search?q=Secret')).body.results.some((r) => r.module === 'budget'));
    assert.equal((await b.admin.agent.get(`/api/budget/summary?month=${month}`)).body.totals.spent, 0);
  });

  test('receipt upload accepts images/PDF only and is removable', async () => {
    const h = await household('Receipts');
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 12 });
    const up = await h.admin.agent.upload(`/api/budget/transactions/${t.body.id}/receipt`, { file: PNG_1X1, filename: 'r.png' });
    assert.equal(up.status, 200);
    assert.match(up.body.receipt_url, /^\/uploads\/\d+\//);
    const img = await fetch(srv.base + up.body.receipt_url, { headers: { cookie: h.admin.agent.cookie } });
    assert.equal(img.status, 200);
    const txt = await h.admin.agent.upload(`/api/budget/transactions/${t.body.id}/receipt`, { file: Buffer.from('hi'), filename: 'a.txt', type: 'text/plain' });
    assert.equal(txt.status, 400);
    assert.equal((await h.child.agent.upload(`/api/budget/transactions/${t.body.id}/receipt`, { file: PNG_1X1 })).status, 403);
    const rm = await h.admin.agent.del(`/api/budget/transactions/${t.body.id}/receipt`);
    assert.equal(rm.body.receipt_url, null);
    const gone = await fetch(srv.base + up.body.receipt_url, { headers: { cookie: h.admin.agent.cookie } });
    assert.equal(gone.status, 404);
  });

  test('crossing a category limit notifies the other grown-ups once', async () => {
    const h = await household('Limits');
    const dining = h.cat('Dining');
    await h.admin.agent.patch(`/api/budget/categories/${dining.id}`, { monthly_limit: 100 });
    await h.admin.agent.post('/api/budget/transactions', { amount: 80, category_id: dining.id });
    let n = (await h.member.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'budget');
    assert.equal(n.length, 0);
    await h.admin.agent.post('/api/budget/transactions', { amount: 30, category_id: dining.id });
    n = (await h.member.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'budget');
    assert.equal(n.length, 1);
    assert.match(n[0].title, /Dining is over budget/);
    // Kids aren't bothered; the actor isn't notified; further spending doesn't re-notify.
    assert.equal((await h.child.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'budget').length, 0);
    assert.equal((await h.admin.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'budget').length, 0);
    await h.admin.agent.post('/api/budget/transactions', { amount: 30, category_id: dining.id });
    assert.equal((await h.member.agent.get('/api/notifications')).body.items.filter((x) => x.module === 'budget').length, 1);
    const s = (await h.admin.agent.get('/api/budget/summary')).body;
    const d = s.categories.find((c) => c.id === dining.id);
    assert.equal(d.total, 140);
    assert.equal(d.monthly_limit, 100);
  });

  test('mutations broadcast budget.* events and log wall activity', async () => {
    const h = await household('Live');
    const { events } = await collectEvents(h.member.agent, { until: (e) => e.type === 'budget.transaction.deleted', timeoutMs: 4000 });
    const t = await h.admin.agent.post('/api/budget/transactions', { amount: 9.99, description: 'Movie' });
    await h.admin.agent.patch(`/api/budget/transactions/${t.body.id}`, { amount: 12 });
    await h.admin.agent.del(`/api/budget/transactions/${t.body.id}`);
    const types = (await events).map((e) => e.type);
    assert.ok(types.includes('budget.transaction.created'));
    assert.ok(types.includes('budget.transaction.updated'));
    assert.ok(types.includes('budget.transaction.deleted'));
    assert.ok(types.includes('activity'));
    const act = (await h.member.agent.get('/api/activity?module=budget')).body;
    assert.ok(act.some((a) => /added an expense: Movie/.test(a.summary) && a.link.startsWith('/budget/transactions')));

    // Other families don't receive the events
    const other = await household('Live other');
    const { events: otherEvents } = await collectEvents(other.admin.agent, { count: 1, timeoutMs: 800 });
    await h.admin.agent.post('/api/budget/transactions', { amount: 1 });
    assert.ok(!(await otherEvents).some((e) => e.type.startsWith('budget.')));
  });
});

describe('recurring bills', () => {
  test('manual bill: status, pay, undo, skip', async () => {
    const h = await household('Bills');
    const future = Math.min(28, new Date().getDate() + 1);
    const create = await h.admin.agent.post('/api/budget/recurring', {
      description: 'Piano lessons', amount: 120, category_id: h.cat('Kids').id, day_of_month: 1, paid_by: h.member.user.id,
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.auto_create, false);
    const expected = dueDate(month, 1) < today ? 'overdue' : dueDate(month, 1) === today ? 'due_today' : 'upcoming';
    assert.equal(create.body.status, expected);

    // validation + permissions
    assert.equal((await h.admin.agent.post('/api/budget/recurring', { description: 'X', amount: 5, day_of_month: 32 })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/recurring', { amount: 5 })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/recurring', { description: 'X', amount: 5, start_month: '2026-05', end_month: '2026-01' })).status, 400);
    assert.equal((await h.child.agent.post('/api/budget/recurring', { description: 'X', amount: 5 })).status, 403);
    assert.equal((await h.child.agent.post(`/api/budget/recurring/${create.body.id}/pay`, { month })).status, 403);

    const paid = await h.member.agent.post(`/api/budget/recurring/${create.body.id}/pay`, { month, amount: 125 });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'paid');
    assert.equal(paid.body.paid_amount, 125);
    assert.ok(paid.body.transaction_id);
    const tx = (await h.admin.agent.get(`/api/budget/transactions/${paid.body.transaction_id}`)).body;
    assert.equal(tx.recurring_id, create.body.id);
    assert.equal(tx.description, 'Piano lessons');
    assert.equal(tx.paid_by, h.member.user.id);
    assert.equal((await h.member.agent.post(`/api/budget/recurring/${create.body.id}/pay`, { month })).status, 409);

    const undo = await h.admin.agent.del(`/api/budget/recurring/${create.body.id}/runs/${month}`);
    assert.equal(undo.status, 200);
    assert.equal(undo.body.status, expected);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions/${paid.body.transaction_id}`)).status, 404);

    const skipped = await h.admin.agent.post(`/api/budget/recurring/${create.body.id}/skip`, { month });
    assert.equal(skipped.body.status, 'skipped');
    const list = (await h.admin.agent.get(`/api/budget/recurring?month=${month}`)).body;
    assert.equal(list.find((b) => b.id === create.body.id).status, 'skipped');

    // A bill isn't listed before its start month
    const later = await h.admin.agent.post('/api/budget/recurring', { description: 'Later', amount: 5, day_of_month: future, start_month: addMonths(month, 1) });
    assert.ok(!(await h.admin.agent.get(`/api/budget/recurring?month=${month}`)).body.some((b) => b.id === later.body.id));
    assert.equal((await h.admin.agent.post(`/api/budget/recurring/${later.body.id}/pay`, { month })).status, 400);

    // Edit + delete (payments stay as history)
    const e = await h.admin.agent.patch(`/api/budget/recurring/${create.body.id}`, { amount: 130, notes: 'Ms. D' });
    assert.equal(e.body.amount, 130);
    assert.equal((await h.admin.agent.del(`/api/budget/recurring/${create.body.id}`)).status, 200);
    assert.equal((await h.admin.agent.get(`/api/budget/recurring?month=${month}`)).body.some((b) => b.id === create.body.id), false);
  });

  test('auto bills generate their transaction on the due date, exactly once', async () => {
    const h = await household('Auto');
    const dom = new Date().getDate();
    const created = await h.admin.agent.post('/api/budget/recurring', {
      description: 'Netflix', amount: 15.49, category_id: h.cat('Entertainment').id, day_of_month: dom, auto_create: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'paid');
    const txs = (await h.admin.agent.get(`/api/budget/transactions?month=${month}&recurring_id=${created.body.id}`)).body;
    assert.equal(txs.length, 1);
    assert.equal(txs[0].amount, 15.49);
    // Re-running the generator (reads, sweep) doesn't duplicate.
    await h.admin.agent.get(`/api/budget/summary?month=${month}`);
    sweep(srv.ctx);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&recurring_id=${created.body.id}`)).body.length, 1);
    // Undoing an auto payment marks the month skipped (so it isn't re-created).
    const undo = await h.admin.agent.del(`/api/budget/recurring/${created.body.id}/runs/${month}`);
    assert.equal(undo.body.status, 'skipped');
    sweep(srv.ctx);
    assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&recurring_id=${created.body.id}`)).body.length, 0);
    // A member whose day is behind the family's (travelling) undoes it on the due day: still skipped,
    // because the family's sweep already counts it as due.
    assert.equal((await h.admin.agent.post(`/api/budget/recurring/${created.body.id}/pay`, { month })).body.status, 'paid');
    const famToday = srv.ctx.time.todayForFamily(h.family.id);
    const behind = new Date(`${famToday}T12:00:00Z`);
    behind.setUTCDate(behind.getUTCDate() - 1);
    const behindDay = behind.toISOString().slice(0, 10);
    if (dueDate(month, dom) === famToday && Math.abs(behind - Date.now()) <= 36 * 3600e3) {
      assert.equal((await h.admin.agent.del(`/api/budget/recurring/${created.body.id}/runs/${month}?today=${behindDay}`)).body.status, 'skipped');
      sweep(srv.ctx);
      assert.equal((await h.admin.agent.get(`/api/budget/transactions?month=${month}&recurring_id=${created.body.id}`)).body.length, 0);
    }
    // ...but undoing an early payment (not due yet) just makes it upcoming again, so it still auto-pays on the day.
    const next = addMonths(month, 1);
    assert.equal((await h.admin.agent.post(`/api/budget/recurring/${created.body.id}/pay`, { month: next })).body.status, 'paid');
    assert.equal((await h.admin.agent.del(`/api/budget/recurring/${created.body.id}/runs/${next}`)).body.status, 'upcoming');

    // Engine: generates each due month since creation, never before it.
    const fid = h.family.id;
    const nextMonth = addMonths(month, 1);
    const later = generateDue(srv.db, fid, dueDate(nextMonth, 31));
    assert.equal(later.length, 1, 'next month generates once due');
    assert.equal(generateDue(srv.db, fid, dueDate(nextMonth, 31)).length, 0);

    // "Created on its due day" is judged in the family's zone: 8 pm in Chicago on Mar 10 is already Mar 11 in UTC.
    const evening = (await household('Evening')).family.id;
    srv.db.prepare(
      `INSERT INTO budget_recurring (family_id, kind, description, amount_cents, day_of_month, auto_create, start_month, created_at)
       VALUES (?, 'expense', 'Gym', 3000, 10, 1, '2026-03', '2026-03-11T01:00:00.000Z')`,
    ).run(evening);
    assert.equal(generateDue(srv.db, evening, '2026-03-10', 'America/Chicago').length, 1);
  });

  test('bills are family-scoped and due-today reminders are sent once', async () => {
    const a = await household('Bill A');
    const b = await household('Bill B');
    const dom = new Date().getDate();
    const bill = await a.admin.agent.post('/api/budget/recurring', { description: 'Electric', amount: 130, day_of_month: dom, paid_by: a.member.user.id });
    assert.equal(bill.body.status, 'due_today');
    assert.equal((await b.admin.agent.patch(`/api/budget/recurring/${bill.body.id}`, { amount: 1 })).status, 404);
    assert.equal((await b.admin.agent.post(`/api/budget/recurring/${bill.body.id}/pay`, { month })).status, 404);
    assert.equal((await b.admin.agent.del(`/api/budget/recurring/${bill.body.id}`)).status, 404);
    assert.equal((await a.admin.agent.get('/api/budget/badge')).body.bills_due, 1);
    assert.equal((await a.child.agent.get('/api/budget/badge')).body.bills_due, 0);
    assert.equal((await b.admin.agent.get('/api/budget/badge')).body.bills_due, 0);
    sweep(srv.ctx);
    sweep(srv.ctx);
    const n = (await a.member.agent.get('/api/notifications')).body.items.filter((x) => x.title === 'Electric is due today');
    assert.equal(n.length, 1);
  });
});

describe('goals and allowances', () => {
  test('goal lifecycle: deposits, withdrawals, reached', async () => {
    const h = await household('Goals');
    const g = await h.admin.agent.post('/api/budget/goals', { name: 'Beach trip', emoji: '🏖️', target: 100, saved: 20, target_date: '2027-06-01' });
    assert.equal(g.status, 201);
    assert.equal(g.body.saved, 20);
    assert.equal(g.body.target, 100);
    assert.equal((await h.admin.agent.post('/api/budget/goals', { name: 'X' })).status, 400);
    assert.equal((await h.admin.agent.post('/api/budget/goals', { name: 'X', target: 5, target_date: 'soon' })).status, 400);

    const dep = await h.member.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: 30, note: 'Birthday money' });
    assert.equal(dep.status, 201);
    assert.equal(dep.body.saved, 50);
    assert.equal(dep.body.entries.length, 2);
    assert.equal((await h.member.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: -80 })).status, 400);
    const wd = await h.member.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: -10 });
    assert.equal(wd.body.saved, 40);

    const reached = await h.admin.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: 60 });
    assert.equal(reached.body.saved, 100);
    assert.ok(reached.body.completed_at);
    const notes = (await h.child.agent.get('/api/notifications')).body.items;
    assert.ok(notes.some((x) => /Goal reached: Beach trip/.test(x.title)));
    const act = (await h.admin.agent.get('/api/activity?module=budget')).body;
    assert.ok(act.some((a) => /reached the savings goal/.test(a.summary)));

    // Removing an entry re-opens the goal
    const entry = reached.body.entries[0];
    const after = await h.admin.agent.del(`/api/budget/goals/${g.body.id}/entries/${entry.id}`);
    assert.equal(after.body.saved, 40);
    assert.equal(after.body.completed_at, null);
    assert.equal((await h.admin.agent.post('/api/budget/goals', { name: 'Y', target: 5, target_date: '2200-01-01' })).status, 400);

    // Kids: own goals only
    assert.equal((await h.child.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: 5 })).status, 403);
    assert.equal((await h.child.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: -5 })).status, 403);
    assert.equal((await h.child.agent.patch(`/api/budget/goals/${g.body.id}`, { name: 'Mine' })).status, 403);
    assert.equal((await h.child.agent.post('/api/budget/goals', { name: 'For dad', target: 5, owner_id: h.admin.user.id })).status, 403);
    const own = await h.child.agent.post('/api/budget/goals', { name: 'Bike', target: 200 });
    assert.equal(own.status, 201);
    assert.equal(own.body.owner_id, h.child.user.id);
    assert.equal((await h.child.agent.patch(`/api/budget/goals/${own.body.id}`, { target: 180 })).status, 200);
    assert.equal((await h.child.agent.post(`/api/budget/goals/${own.body.id}/entries`, { amount: 12 })).status, 201);
    assert.equal((await h.child.agent.del(`/api/budget/goals/${own.body.id}`)).status, 200);

    // Scoped
    const other = await household('Goals other');
    assert.equal((await other.admin.agent.get(`/api/budget/goals/${g.body.id}`)).status, 404);
    assert.equal((await other.admin.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: 1 })).status, 404);
    assert.equal((await other.admin.agent.del(`/api/budget/goals/${g.body.id}`)).status, 404);
    assert.equal((await other.admin.agent.get('/api/budget/goals')).body.length, 0);
  });

  test('allowance: set, pay into goal + record expense + notify the kid', async () => {
    const h = await household('Allowance');
    const goal = await h.admin.agent.post('/api/budget/goals', { name: 'LEGO', target: 50, owner_id: h.child.user.id });
    assert.equal((await h.child.agent.put(`/api/budget/allowances/${h.child.user.id}`, { amount: 5 })).status, 403);
    assert.equal((await h.admin.agent.put(`/api/budget/allowances/${h.child.user.id}`, { amount: 5, frequency: 'daily' })).status, 400);
    const outsider = await registerUser(srv, { name: 'Nope' });
    assert.equal((await h.admin.agent.put(`/api/budget/allowances/${outsider.user.id}`, { amount: 5 })).status, 400);
    const set = await h.admin.agent.put(`/api/budget/allowances/${h.child.user.id}`, { amount: 7.5, frequency: 'weekly', goal_id: goal.body.id });
    assert.equal(set.status, 200);
    assert.equal(set.body.amount, 7.5);
    const pay = await h.member.agent.post(`/api/budget/allowances/${h.child.user.id}/pay`, {});
    assert.equal(pay.status, 200);
    assert.ok(pay.body.allowance.last_paid_at);
    const tx = (await h.admin.agent.get(`/api/budget/transactions/${pay.body.transaction_id}`)).body;
    assert.equal(tx.amount, 7.5);
    assert.equal(tx.category.name, 'Kids');
    assert.equal((await h.admin.agent.get(`/api/budget/goals/${goal.body.id}`)).body.saved, 7.5);
    const n = (await h.child.agent.get('/api/notifications')).body.items;
    assert.ok(n.some((x) => /Allowance day/.test(x.title)));
    assert.equal((await h.admin.agent.get('/api/budget/allowances')).body.length, 1);
    assert.equal((await h.admin.agent.del(`/api/budget/allowances/${h.child.user.id}`)).status, 200);
    assert.equal((await h.admin.agent.post(`/api/budget/allowances/${h.child.user.id}/pay`)).status, 404);
  });
});

describe('automatic monthly goal contributions', () => {
  test('amount: what is left ÷ months remaining (inclusive), rounded up, never above what is left', () => {
    assert.equal(autoAmount(1160_00, '2026-10', '2027-06-20'), 12889); // 9 months: 128.888… → 128.89
    assert.equal(autoAmount(1200_00, '2026-10', '2027-09-30'), 100_00); // 12 months, exact
    assert.equal(autoAmount(100, '2026-10', '2026-12-01'), 34); // 33.3… → 34 cents
    assert.equal(autoAmount(5, '2026-10', '2027-10-01'), 1); // a cent left over 13 months still gets paid
    assert.equal(autoAmount(123_45, '2027-06', '2027-06-30'), 123_45); // last month: everything left
    assert.equal(autoAmount(100_00, '2026-12', '2027-01-05'), 50_00); // across a year boundary
    assert.equal(autoAmount(100_00, '2027-07', '2027-06-30'), 0); // target month passed: stop
    assert.equal(autoAmount(0, '2026-10', '2027-06-30'), 0);
    assert.equal(autoAmount(-5_00, '2026-10', '2027-06-30'), 0);
    assert.equal(autoAmount(100_00, '2026-10', null), 0);
    for (let left = 1; left < 5000; left += 7) {
      for (const target of ['2026-10-31', '2026-11-01', '2027-03-15', '2028-12-31']) {
        // Paying it every month reaches the goal exactly in the target month, never overshooting.
        let rest = left;
        for (let m = '2026-10'; m <= target.slice(0, 7); m = addMonths(m, 1)) {
          const c = autoAmount(rest, m, target);
          assert.ok(c >= 1 && c <= rest, `${left} ${m} ${target} → ${c}`);
          rest -= c;
          if (!rest) break;
        }
        assert.equal(rest, 0);
      }
    }
  });

  test('once per month, recalculated, deleted entries stay deleted, stops when reached', async () => {
    const h = await household('Auto goals');
    const fid = h.family.id;
    const m0 = monthOf(srv.ctx.time.todayForFamily(fid));
    const month = (n) => `${addMonths(m0, n)}-01`;
    const entries = async (id) => (await h.admin.agent.get(`/api/budget/goals/${id}`)).body;
    // Turned on when created: this month's contribution is made right away (12 months → $100).
    const g = await h.admin.agent.post('/api/budget/goals', { name: 'Laptop', emoji: '💻', target: 1200, target_date: dueDate(addMonths(m0, 11), 15), auto_monthly: true });
    assert.equal(g.status, 201);
    assert.equal(g.body.auto_monthly, true);
    assert.equal(g.body.saved, 100);
    assert.equal(g.body.auto_last_month, m0);
    let d = await entries(g.body.id);
    assert.equal(d.entries.length, 1);
    assert.equal(d.entries[0].source, 'auto');
    assert.equal(d.entries[0].note, `Monthly contribution · ${monthLabel(m0, 'short')}`);
    // Sweeps, saves and calls again this month don't add more.
    sweep(srv.ctx);
    sweep(srv.ctx);
    assert.equal(autoContribute(srv.ctx, fid, `${m0}-28`), 0);
    assert.equal((await h.admin.agent.patch(`/api/budget/goals/${g.body.id}`, { name: 'New laptop' })).body.saved, 100);
    assert.equal((await entries(g.body.id)).entries.length, 1);

    // Next month: 1100 left over 11 months.
    sweep(srv.ctx, month(1));
    sweep(srv.ctx, month(1));
    assert.equal((await entries(g.body.id)).saved, 200);
    // A withdrawal changes the next amount: 1050 left over 10 months → 105.
    await h.admin.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: -50 });
    sweep(srv.ctx, month(2));
    d = await entries(g.body.id);
    assert.equal(d.saved, 255);
    assert.equal(d.auto_last_month, addMonths(m0, 2));
    // Deleting an automatic entry is respected: that month isn't re-created.
    const auto2 = d.entries.find((e) => e.note === `Monthly contribution · ${monthLabel(addMonths(m0, 2), 'short')}`);
    assert.equal((await h.admin.agent.del(`/api/budget/goals/${g.body.id}/entries/${auto2.id}`)).body.saved, 150);
    sweep(srv.ctx, month(2));
    assert.equal(autoContribute(srv.ctx, fid, month(2)), 0);
    assert.equal((await entries(g.body.id)).saved, 150);
    // No backfill: jumping to the target month pays only that month — everything left — and completes the goal.
    sweep(srv.ctx, month(11));
    d = await entries(g.body.id);
    assert.equal(d.saved, 1200);
    assert.ok(d.completed_at);
    assert.equal(d.entries.filter((e) => e.source === 'auto').length, 3);
    assert.ok((await h.child.agent.get('/api/notifications')).body.items.some((x) => x.title === 'Goal reached: New laptop 🎉'));
    assert.ok((await h.admin.agent.get('/api/activity?module=budget')).body.some((a) => a.verb === 'goal_reached' && a.entity_id === g.body.id));
    sweep(srv.ctx, month(12));
    assert.equal((await entries(g.body.id)).entries.length, 4);

    // Past its target month: nothing more is contributed.
    const late = await h.admin.agent.post('/api/budget/goals', { name: 'Late', target: 300, target_date: `${m0}-20` });
    // (Synchronous from here, so the startup sweep can't slip in this month's contribution.)
    srv.db.prepare('UPDATE budget_goals SET auto_monthly = 1 WHERE id = ?').run(late.body.id);
    assert.equal(autoContribute(srv.ctx, fid, month(1)), 0);
    sweep(srv.ctx, month(1));
    const saved = () => srv.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM budget_goal_entries WHERE goal_id = ?').get(late.body.id).c;
    assert.equal(saved(), 0);
    // ...while in its last month the rest arrives in one go.
    assert.equal(autoContribute(srv.ctx, fid, `${m0}-20`), 1);
    assert.equal(saved(), 300_00);
  });

  test('the family hears about it once a month: one summary for grown-ups (and owners)', async () => {
    const h = await household('Auto summary');
    const fid = h.family.id;
    const m0 = monthOf(srv.ctx.time.todayForFamily(fid));
    const date = dueDate(addMonths(m0, 3), 1); // 4 months
    const a = await h.admin.agent.post('/api/budget/goals', { name: 'Holiday', emoji: '🏖️', target: 920, target_date: date });
    const b = await h.admin.agent.post('/api/budget/goals', { name: 'Bike', target: 480, target_date: date, owner_id: h.child.user.id });
    const summaries = async (who) => (await who.agent.get('/api/notifications')).body.items.filter((x) => /automatically$/.test(x.title));
    // Switching it on contributes this month right away, logged like a normal deposit by whoever did it
    // (so parents see a kid's too) — no automatic summary for that.
    assert.equal((await h.admin.agent.patch(`/api/budget/goals/${a.body.id}`, { auto_monthly: true })).body.saved, 230);
    assert.equal((await h.child.agent.patch(`/api/budget/goals/${b.body.id}`, { auto_monthly: true })).body.saved, 120);
    const act = (await h.member.agent.get('/api/activity?module=budget')).body;
    assert.ok(act.some((x) => x.verb === 'saved' && x.user?.id === h.admin.user.id && x.summary === 'added $230.00 to 🏖️ Holiday'));
    assert.ok(act.some((x) => x.verb === 'saved' && x.user?.id === h.child.user.id && x.summary === 'added $120.00 to Bike'));
    assert.equal((await summaries(h.member)).length, 0);
    // Next month's sweep: one summary covering both goals, sent once however often the sweep runs.
    const next = `${addMonths(m0, 1)}-01`;
    sweep(srv.ctx, next);
    sweep(srv.ctx, next);
    sweep(srv.ctx, `${addMonths(m0, 1)}-17`);
    const n = await summaries(h.member);
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Saved $350.00 automatically');
    assert.equal(n[0].body, '🏖️ Holiday $230.00 · Bike $120.00');
    assert.equal((await summaries(h.admin)).length, 1);
    assert.equal((await summaries(h.child)).length, 1, 'owners of goals in the summary are told');
    const wall = (await h.member.agent.get('/api/activity?module=budget')).body.filter((x) => x.verb === 'auto_saved');
    assert.equal(wall.length, 1);
    assert.equal(wall[0].summary, 'saved $350.00 automatically: 🏖️ Holiday $230.00 · Bike $120.00');
    assert.equal(wall[0].user, null);
    // A kid with no automatic goal of their own doesn't see the family's savings summary on the Wall.
    const solo = await household('Auto solo');
    await solo.admin.agent.post('/api/budget/goals', { name: 'Car', target: 100, target_date: date, auto_monthly: true });
    sweep(srv.ctx, next);
    assert.equal((await solo.member.agent.get('/api/activity?module=budget')).body.filter((x) => x.verb === 'auto_saved').length, 1);
    assert.equal((await solo.child.agent.get('/api/activity?module=budget')).body.filter((x) => x.verb === 'auto_saved').length, 0);
    assert.equal((await summaries(solo.child)).length, 0);
  });

  test('a reached goal that dips below its target mid-month waits for the 1st', async () => {
    const h = await household('Auto midmonth');
    const fid = h.family.id;
    const m0 = monthOf(srv.ctx.time.todayForFamily(fid));
    const month = (n, day = '01') => `${addMonths(m0, n)}-${day}`;
    const date = dueDate(addMonths(m0, 3), 10);
    const autoEntries = async (id) => (await h.admin.agent.get(`/api/budget/goals/${id}`)).body.entries.filter((e) => e.source === 'auto');
    // Reached when created: this month is claimed with nothing added.
    const g = await h.admin.agent.post('/api/budget/goals', { name: 'Reached', target: 100, saved: 100, target_date: date, auto_monthly: true });
    assert.ok(g.body.completed_at);
    assert.equal(g.body.auto_last_month, m0);
    // Reached before next month's 1st: the 1st claims that month without an entry...
    sweep(srv.ctx, month(1));
    // ...so a withdrawal on the 5th doesn't trigger a top-up that month.
    await h.admin.agent.post(`/api/budget/goals/${g.body.id}/entries`, { amount: -50 });
    sweep(srv.ctx, month(1, '05'));
    assert.equal(autoContribute(srv.ctx, fid, month(1, '20')), 0);
    assert.equal((await autoEntries(g.body.id)).length, 0);
    // The 1st after that: 50 left over 2 months.
    sweep(srv.ctx, month(2));
    assert.deepEqual((await autoEntries(g.body.id)).map((e) => e.amount), [25]);

    // Same when a deposit on a reached goal is deleted mid-month.
    const d = await h.admin.agent.post('/api/budget/goals', { name: 'Dip', target: 100, target_date: date, auto_monthly: true });
    assert.equal(d.body.saved, 25); // 4 months
    const dep = await h.admin.agent.post(`/api/budget/goals/${d.body.id}/entries`, { amount: 75 });
    assert.ok(dep.body.completed_at);
    sweep(srv.ctx, month(1));
    await h.admin.agent.del(`/api/budget/goals/${d.body.id}/entries/${dep.body.entries[0].id}`);
    sweep(srv.ctx, month(1, '12'));
    assert.equal((await autoEntries(d.body.id)).length, 1);
    sweep(srv.ctx, month(2));
    assert.deepEqual((await autoEntries(d.body.id)).map((e) => e.amount), [37.5, 25]); // 75 left over 2 months
  });

  test('permissions and validation', async () => {
    const h = await household('Auto perms');
    const m0 = monthOf(srv.ctx.time.todayForFamily(h.family.id));
    const date = dueDate(addMonths(m0, 5), 10);
    // Needs a target date — on create, and it can't be removed while the option is on.
    assert.equal((await h.admin.agent.post('/api/budget/goals', { name: 'X', target: 50, auto_monthly: true })).status, 400);
    const fam = await h.admin.agent.post('/api/budget/goals', { name: 'Family', target: 600, target_date: date, auto_monthly: true });
    assert.equal(fam.status, 201);
    const cleared = await h.admin.agent.patch(`/api/budget/goals/${fam.body.id}`, { target_date: null });
    assert.equal(cleared.status, 400);
    assert.match(cleared.body.error, /target date/);
    const off = await h.admin.agent.patch(`/api/budget/goals/${fam.body.id}`, { target_date: null, auto_monthly: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.auto_monthly, false);
    // Kids: only their own goals (whoever can edit the goal can toggle it).
    assert.equal((await h.child.agent.patch(`/api/budget/goals/${fam.body.id}`, { target_date: date, auto_monthly: true })).status, 403);
    const own = await h.child.agent.post('/api/budget/goals', { name: 'Skates', target: 60, target_date: date, auto_monthly: true });
    assert.equal(own.status, 201);
    assert.equal(own.body.saved, 10);
    const offAgain = (await h.child.agent.patch(`/api/budget/goals/${own.body.id}`, { auto_monthly: false })).body;
    assert.equal(offAgain.auto_monthly, false);
    assert.equal(offAgain.auto_last_month, m0, 'still reported while off, so the form knows this month is done');
    assert.equal((await h.member.agent.patch(`/api/budget/goals/${own.body.id}`, { auto_monthly: true })).body.auto_monthly, true);
    // Turning it back on in a month that already had its contribution doesn't add another.
    assert.equal((await h.child.agent.get(`/api/budget/goals/${own.body.id}`)).body.saved, 10);
    const other = await household('Auto other');
    assert.equal((await other.admin.agent.patch(`/api/budget/goals/${own.body.id}`, { auto_monthly: false })).status, 404);
  });

  test("the month turns over at midnight on the 1st in the family's time zone", async () => {
    // 10:30 UTC on Oct 31 is already 00:30 on Nov 1 in Kiritimati (UTC+14), but 05:30 on Oct 31 in Chicago.
    // (A past date, so the startup sweep's real-month contribution can't be confused with these.)
    const instant = new Date('2025-10-31T10:30:00Z');
    const families = [];
    for (const zone of ['Pacific/Kiritimati', 'America/Chicago']) {
      const h = await household(`Auto ${zone}`);
      srv.db.prepare('UPDATE users SET timezone = ? WHERE id IN (?, ?, ?)').run(zone, h.admin.user.id, h.member.user.id, h.child.user.id);
      const g = await h.admin.agent.post('/api/budget/goals', { name: 'Trip', target: 1000, target_date: '2027-08-15' });
      srv.db.prepare('UPDATE budget_goals SET auto_monthly = 1 WHERE id = ?').run(g.body.id);
      const today = srv.ctx.time.dateIn(srv.ctx.time.familyTz(h.family.id), instant);
      autoContribute(srv.ctx, h.family.id, today);
      families.push({ h, g, today });
    }
    const [kiri, chicago] = families;
    assert.equal(kiri.today, '2025-11-01');
    assert.equal(chicago.today, '2025-10-31');
    const auto = async ({ h, g }) => (await h.admin.agent.get(`/api/budget/goals/${g.body.id}`)).body.entries
      .filter((e) => e.note.endsWith('2025')).map((e) => [e.note, e.amount]);
    assert.deepEqual(await auto(kiri), [['Monthly contribution · Nov 2025', 45.46]]); // 22 months left
    assert.deepEqual(await auto(chicago), [['Monthly contribution · Oct 2025', 43.48]]); // 23 months left
  });
});

describe('seed + dashboard', () => {
  test('seed creates rich demo data and the dashboard summarises it', async () => {
    const quiet = { log: () => {} };
    await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    const { familyId } = await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    const db = srv.db;
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    // The demo family's month/day (its own zone), not the test process's.
    const familyDay = srv.ctx.time.todayForFamily(familyId);
    const month = monthOf(familyDay);
    const prev = addMonths(month, -1);
    assert.ok(count("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND date LIKE ? || '%'", familyId, prev) >= 25);
    // The seed never invents future-dated rows, so early in a month the current month is still sparse.
    const dayOfMonth = Number(familyDay.slice(8, 10));
    assert.ok(count("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND date LIKE ? || '%'", familyId, month) >= Math.min(15, dayOfMonth));
    assert.ok(count('SELECT COUNT(*) AS n FROM budget_recurring WHERE family_id = ?', familyId) >= 8);
    assert.ok(count('SELECT COUNT(*) AS n FROM budget_goals WHERE family_id = ?', familyId) >= 4);
    assert.equal(count('SELECT COUNT(*) AS n FROM budget_allowances WHERE family_id = ?', familyId), 2);
    assert.ok(count('SELECT COUNT(*) AS n FROM budget_categories WHERE family_id = ? AND limit_cents IS NOT NULL', familyId) >= 8);
    assert.ok(count('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND receipt_url IS NOT NULL', familyId) >= 1);

    const alex = srv.agent();
    const login = await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
    assert.equal(login.status, 200);
    alex.familyId = familyId;
    const s = (await alex.get(`/api/budget/summary?month=${month}`)).body;
    assert.ok(s.totals.income > 0 && s.totals.spent > 0);
    assert.ok(s.trend.every((t) => t.spent > 0), 'six months of history');
    // Dining is seeded over budget, which only shows once enough of the month has passed.
    if (dayOfMonth >= 20) assert.ok(s.categories.some((c) => c.monthly_limit && c.total > c.monthly_limit), 'something is over budget');
    const dash = (await alex.get('/api/dashboard')).body.budget;
    assert.equal(dash.month, month);
    assert.ok(dash.spent > 0);
    assert.ok(Array.isArray(dash.over_budget) && (dayOfMonth < 20 || dash.over_budget.length >= 1));
    assert.ok(Array.isArray(dash.goals));
    // No duplicate auto-bill transactions after reads
    const before = count('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ?', familyId);
    await alex.get(`/api/budget/recurring?month=${month}`);
    sweep(srv.ctx);
    assert.equal(count('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ?', familyId), before);
  });
});
