import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, registerUser, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo } from '../src/seed.js';
import { sweep } from '../src/modules/budget.js';
import { addMonths, billStatus, dateKey, dueDate, generateDue, monthOf, toCents } from '../src/modules/budget/lib.js';

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
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = dateKey(d);
    const list = (await h.admin.agent.get(`/api/budget/recurring?month=${month}&today=${yesterday}`)).body;
    assert.equal(list.find((b) => b.id === bill.body.id).status, 'upcoming');
    assert.equal((await h.admin.agent.get(`/api/budget/badge?today=${yesterday}`)).body.bills_due, 0);
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

    // Engine: generates each due month since creation, never before it.
    const fid = h.family.id;
    const nextMonth = addMonths(month, 1);
    const later = generateDue(srv.db, fid, dueDate(nextMonth, 31));
    assert.equal(later.length, 1, 'next month generates once due');
    assert.equal(generateDue(srv.db, fid, dueDate(nextMonth, 31)).length, 0);
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

describe('seed + dashboard', () => {
  test('seed creates rich demo data and the dashboard summarises it', async () => {
    const quiet = { log: () => {} };
    await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    const { familyId } = await seedDemo(srv.ctx, srv.app.locals.modules, quiet);
    const db = srv.db;
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const prev = addMonths(month, -1);
    assert.ok(count("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND date LIKE ? || '%'", familyId, prev) >= 25);
    assert.ok(count("SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ? AND date LIKE ? || '%'", familyId, month) >= 15);
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
    assert.ok(s.categories.some((c) => c.monthly_limit && c.total > c.monthly_limit), 'something is over budget');
    const dash = (await alex.get('/api/dashboard')).body.budget;
    assert.equal(dash.month, month);
    assert.ok(dash.spent > 0);
    assert.ok(Array.isArray(dash.over_budget) && dash.over_budget.length >= 1);
    assert.ok(Array.isArray(dash.goals));
    // No duplicate auto-bill transactions after reads
    const before = count('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ?', familyId);
    await alex.get(`/api/budget/recurring?month=${month}`);
    sweep(srv.ctx);
    assert.equal(count('SELECT COUNT(*) AS n FROM budget_transactions WHERE family_id = ?', familyId), before);
  });
});
