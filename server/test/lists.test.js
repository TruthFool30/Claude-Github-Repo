import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, familyFixture, collectEvents } from './helpers.js';
import * as listsModule from '../src/modules/lists.js';
import { guessCategory } from '../src/modules/lists/categories.js';
import { seedDemo } from '../src/seed.js';

const { addDays, flushPendingActivity, sendDueReminders, parseQuantity, purgeDeleted } = listsModule;

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

/** Add a child (with a login) to a fixture family and return a signed-in agent for them. */
async function addChild(fx, name = 'Kiddo') {
  const email = `kid${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  const res = await fx.admin.agent.post('/api/family/members', { name, email, role: 'child', password: 'secret123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const agent = srv.agent();
  const login = await agent.post('/api/auth/login', { email, password: 'secret123' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { agent, user: login.body.user };
}

describe('helpers', () => {
  // Real shopping-list items -> expected aisle (head noun wins; whole words only).
  const AISLES = {
    Produce: ['Bananas', 'Avocados x3', 'Baby spinach', 'Cherry tomatoes', 'Lemons', 'Sweet potatoes', 'Green beans', 'Bell peppers',
      'Brussels sprouts', 'Fresh mint', 'Red onion', 'Garlic', 'Blueberries', 'Pineapple', 'Eggplant', 'Snap peas', 'Peaches'],
    Bakery: ['Sourdough bread', 'Garlic bread', 'Dinner rolls', 'Bagels', 'Hot dog buns', 'Hamburger buns', 'Tortillas', 'Birthday cake', 'Croissants', 'Apple pie'],
    Dairy: ['Oat milk', 'Eggs', 'Greek yogurt', 'Cheddar cheese', 'Cream cheese', 'Butter', 'Sour cream', 'Hummus', 'Guacamole', 'Chocolate milk', 'Crème fraîche'],
    Meat: ['Chicken thighs', 'Ground beef', 'Bacon', 'Hot dogs', 'Salmon fillet', 'Pork chops', 'Tuna steak', 'Shrimp', 'Burger patties'],
    Pantry: ['Tomato sauce', 'Mushroom soup', 'Chicken stock', 'Black pepper', 'Cornstarch', 'Peanut butter', 'Almond butter', 'Olive oil',
      'Penne pasta', 'Egg noodles', 'Black beans', 'Coffee beans', 'Canned tomatoes', 'Coconut milk', 'Maple syrup', 'Tea bags',
      'Garlic powder', 'Soy sauce', 'Rolled oats', 'Chocolate chips', 'Salad dressing', 'Hot chocolate', 'Cake mix', 'Fruit loops', 'Mac and cheese', 'Cheerios'],
    Frozen: ['Frozen peas', 'Ice cream', 'Frozen berries', 'French fries', 'Fish sticks', 'Hash browns', 'Bag of ice', 'Chicken nuggets', 'Onion rings', 'Veggie burgers', 'Frozen burger patties'],
    Drinks: ['Orange juice', 'Sparkling water', 'Apple juice', 'Lemonade', 'Iced tea', 'Red wine', 'Juice boxes', 'Ginger ale', 'Root beer'],
    Snacks: ['Peanuts', 'Mint gum', 'Cotton candy', 'Chocolate chip cookies', 'Tortilla chips', 'Potato chips', 'Granola bars', 'Pretzels', 'Beef jerky', 'Trail mix'],
    Household: ['Kitchen roll', 'Rolls of tape', 'Tea lights', 'Paper towels', 'Toilet paper', 'Aluminium foil', 'Trash bags', 'Dish soap',
      'Dishwasher pods', 'AA batteries', 'Dog treats', 'Laundry detergent', 'Light bulbs', 'Lightbulbs', 'Sandwich bags'],
    'Personal care': ['Toothpaste', 'Q-tips', 'Band-Aids', 'Baby wipes', 'Cotton balls', 'Shampoo', 'Diapers', 'Sunscreen', 'Hand soap'],
    Other: ['Widget', 'Birthday card', 'Stamps'],
  };
  test('guessCategory files 100+ real grocery items into the right aisle', () => {
    const wrong = [];
    let n = 0;
    for (const [cat, items] of Object.entries(AISLES)) {
      for (const it of items) {
        n++;
        const got = guessCategory(it);
        if (got !== cat) wrong.push(`${it}: expected ${cat}, got ${got}`);
      }
    }
    assert.ok(n >= 60, `table has ${n} items`);
    assert.deepEqual(wrong, []);
  });
  test('parseQuantity only understands explicit forms', () => {
    assert.deepEqual(parseQuantity('Milk x2'), { text: 'Milk', quantity: '2' });
    assert.deepEqual(parseQuantity('3 x Lemons'), { text: 'Lemons', quantity: '3' });
    assert.deepEqual(parseQuantity('7 Up'), { text: '7 Up', quantity: null });
  });
});

describe('lists CRUD', () => {
  test('create, read, update and delete a list with validation', async () => {
    const fx = await familyFixture(srv, 'Crud');
    const a = fx.admin.agent;

    assert.equal((await a.post('/api/lists', {})).status, 400);
    assert.equal((await a.post('/api/lists', { name: '   ' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x', type: 'bogus' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x', color: 'red' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x'.repeat(81) })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x', icon: 'two words' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x', icon: 'ab' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'x', icon: '🧹🧹' })).status, 400);
    assert.equal((await a.post('/api/lists', { name: 'Fam', icon: '👨‍👩‍👧' })).status, 201);
    assert.equal((await a.post('/api/lists', { name: 'Flag', icon: '🇲🇾' })).status, 201);

    const created = await a.post('/api/lists', { name: 'Groceries', type: 'shopping' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Groceries');
    assert.equal(created.body.type, 'shopping');
    assert.equal(created.body.icon, '🛒');
    assert.match(created.body.color, /^#[0-9A-Fa-f]{6}$/);
    assert.equal(created.body.item_count, 0);
    assert.equal(created.body.can_manage, true);

    const todo = await a.post('/api/lists', { name: 'Chores', type: 'todo', icon: '🧹', color: '#F76B15' });
    assert.equal(todo.body.icon, '🧹');
    assert.equal(todo.body.color, '#F76B15');

    const all = await a.get('/api/lists');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.map((l) => l.name), ['Fam', 'Flag', 'Groceries', 'Chores']);

    const shopping = await a.get('/api/lists?type=shopping');
    assert.deepEqual(shopping.body.map((l) => [l.name, l.type]), [['Groceries', 'shopping']]);
    assert.ok('id' in shopping.body[0] && 'open_count' in shopping.body[0]);
    assert.equal((await a.get('/api/lists?type=nope')).status, 400);

    const got = await a.get(`/api/lists/${todo.body.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.items, []);

    const renamed = await a.patch(`/api/lists/${todo.body.id}`, { name: 'Weekend chores', icon: '✨' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Weekend chores');
    assert.equal(renamed.body.icon, '✨');
    assert.equal((await a.patch(`/api/lists/${todo.body.id}`, { name: '' })).status, 400);
    assert.equal((await a.patch(`/api/lists/${todo.body.id}`, { color: 'nope' })).status, 400);

    // The member can manage lists too.
    const byMember = await fx.member.agent.patch(`/api/lists/${todo.body.id}`, { name: 'Chores!' });
    assert.equal(byMember.status, 200);

    assert.equal((await a.del(`/api/lists/${todo.body.id}`)).status, 200);
    assert.equal((await a.get(`/api/lists/${todo.body.id}`)).status, 404);
    assert.equal((await a.get('/api/lists/abc')).status, 400);
  });

  test('changing a list to shopping sorts items into aisles', async () => {
    const fx = await familyFixture(srv, 'Convert');
    const a = fx.admin.agent;
    const l = (await a.post('/api/lists', { name: 'Stuff', type: 'other' })).body;
    await a.post(`/api/lists/${l.id}/items`, { text: 'Milk' });
    const conv = await a.patch(`/api/lists/${l.id}`, { type: 'shopping' });
    assert.equal(conv.body.items[0].category, 'Dairy');
  });

  test('duplicate copies items unchecked', async () => {
    const fx = await familyFixture(srv, 'Dup');
    const a = fx.admin.agent;
    const l = (await a.post('/api/lists', { name: 'Packing', type: 'other' })).body;
    const i1 = (await a.post(`/api/lists/${l.id}/items`, { text: 'Towels', quantity: '4' })).body;
    await a.post(`/api/lists/${l.id}/items`, { text: 'Sunscreen' });
    await a.patch(`/api/lists/${l.id}/items/${i1.id}`, { done: true });
    const dup = await a.post(`/api/lists/${l.id}/duplicate`, {});
    assert.equal(dup.status, 201);
    assert.equal(dup.body.name, 'Packing (copy)');
    assert.deepEqual(dup.body.items.map((i) => [i.text, i.quantity, i.done]), [['Towels', '4', false], ['Sunscreen', null, false]]);
  });
});

describe('items', () => {
  test('add, edit, check, reorder, clear completed', async () => {
    const fx = await familyFixture(srv, 'Items');
    const a = fx.admin.agent;
    const shop = (await a.post('/api/lists', { name: 'Groceries', type: 'shopping' })).body;

    assert.equal((await a.post(`/api/lists/${shop.id}/items`, {})).status, 400);
    assert.equal((await a.post(`/api/lists/${shop.id}/items`, { text: 'x'.repeat(201) })).status, 400);
    assert.equal((await a.post(`/api/lists/${shop.id}/items`, { text: 'Milk', due_date: '2026-02-31' })).status, 400);
    assert.equal((await a.post(`/api/lists/${shop.id}/items`, { text: 'Milk', assignee_id: 999999 })).status, 400);
    assert.equal((await a.post(`/api/lists/${shop.id}/items`, { text: 'Milk', quantity: { a: 1 } })).status, 400);

    const milk = await a.post(`/api/lists/${shop.id}/items`, { text: 'Oat milk x2' });
    assert.equal(milk.status, 201);
    assert.equal(milk.body.text, 'Oat milk');
    assert.equal(milk.body.quantity, '2');
    assert.equal(milk.body.category, 'Dairy');
    assert.equal(milk.body.done, false);
    const bread = (await a.post(`/api/lists/${shop.id}/items`, { text: 'Bread', category: 'bakery' })).body;
    assert.equal(bread.category, 'Bakery');
    const soap = (await a.post(`/api/lists/${shop.id}/items`, { text: 'Dish soap', notes: 'Lemon scent' })).body;
    assert.equal(soap.category, 'Household');
    assert.equal(soap.notes, 'Lemon scent');

    // Renaming re-guesses an auto category, but keeps a manual one.
    const renamed = await a.patch(`/api/lists/${shop.id}/items/${milk.body.id}`, { text: 'Frozen peas' });
    assert.equal(renamed.body.category, 'Frozen');
    const manual = await a.patch(`/api/lists/${shop.id}/items/${bread.id}`, { text: 'Bagels' });
    assert.equal(manual.body.category, 'Bakery');

    // Check / uncheck records who and when.
    const done = await a.patch(`/api/lists/${shop.id}/items/${bread.id}`, { done: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.done, true);
    assert.equal(done.body.done_by, fx.admin.user.id);
    assert.ok(done.body.done_at);
    assert.equal((await a.patch(`/api/lists/${shop.id}/items/${bread.id}`, { done: 'yes' })).status, 400);
    const undone = await a.patch(`/api/lists/${shop.id}/items/${bread.id}`, { done: false });
    assert.equal(undone.body.done_by, null);
    assert.equal(undone.body.done_at, null);

    // Reorder.
    const order = [soap.id, milk.body.id, bread.id];
    const re = await a.put(`/api/lists/${shop.id}/items/order`, { ids: order });
    assert.equal(re.status, 200);
    let full = (await a.get(`/api/lists/${shop.id}`)).body;
    assert.deepEqual(full.items.map((i) => i.id), order);
    assert.equal((await a.put(`/api/lists/${shop.id}/items/order`, { ids: [soap.id, soap.id] })).status, 400);
    assert.equal((await a.put(`/api/lists/${shop.id}/items/order`, { ids: [] })).status, 400);

    // Stats.
    await a.patch(`/api/lists/${shop.id}/items/${soap.id}`, { done: true });
    const summary = (await a.get('/api/lists')).body.find((l) => l.id === shop.id);
    assert.equal(summary.item_count, 3);
    assert.equal(summary.done_count, 1);
    assert.equal(summary.open_count, 2);
    assert.equal(summary.preview.length, 2);

    // Uncheck all, then check + clear completed.
    assert.deepEqual((await a.post(`/api/lists/${shop.id}/uncheck-all`)).body, { reset: 1 });
    await a.patch(`/api/lists/${shop.id}/items/${soap.id}`, { done: true });
    const cleared = await a.post(`/api/lists/${shop.id}/clear-completed`);
    assert.deepEqual(cleared.body, { deleted: 1 });
    full = (await a.get(`/api/lists/${shop.id}`)).body;
    assert.equal(full.items.length, 2);

    // Delete an item.
    assert.equal((await a.del(`/api/lists/${shop.id}/items/${bread.id}`)).status, 200);
    assert.equal((await a.del(`/api/lists/${shop.id}/items/${bread.id}`)).status, 404);
  });

  test('items can move between lists of the family', async () => {
    const fx = await familyFixture(srv, 'Move');
    const a = fx.admin.agent;
    const todo = (await a.post('/api/lists', { name: 'Todo', type: 'todo' })).body;
    const shop = (await a.post('/api/lists', { name: 'Shop', type: 'shopping' })).body;
    const item = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Buy eggs' })).body;
    assert.equal(item.category, null);
    const moved = await a.patch(`/api/lists/${todo.id}/items/${item.id}`, { list_id: shop.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.list_id, shop.id);
    assert.equal(moved.body.category, 'Dairy');
    assert.equal((await a.get(`/api/lists/${todo.id}`)).body.items.length, 0);
    assert.equal((await a.get(`/api/lists/${shop.id}`)).body.items.length, 1);

    const other = await familyFixture(srv, 'Move-other');
    const foreign = (await other.admin.agent.post('/api/lists', { name: 'Theirs' })).body;
    assert.equal((await a.patch(`/api/lists/${shop.id}/items/${item.id}`, { list_id: foreign.id })).status, 404);
  });

  test('bulk add (Meals contract)', async () => {
    const fx = await familyFixture(srv, 'Bulk');
    const a = fx.admin.agent;
    const shop = (await a.post('/api/lists', { name: 'Groceries', type: 'shopping' })).body;
    const res = await a.post(`/api/lists/${shop.id}/items/bulk`, {
      items: [
        { text: 'Spaghetti', quantity: '500 g' },
        { text: 'Tomatoes', quantity: 4, category: 'Produce' },
        { text: 'Parmesan' },
        { text: 'Basil', category: 'Herbs' },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(res.body.items.map((i) => [i.text, i.quantity, i.category]), [
      ['Spaghetti', '500 g', 'Pantry'],
      ['Tomatoes', '4', 'Produce'],
      ['Parmesan', null, 'Dairy'],
      ['Basil', null, 'Herbs'],
    ]);
    assert.equal((await a.post(`/api/lists/${shop.id}/items/bulk`, { items: [] })).status, 400);
    assert.equal((await a.post(`/api/lists/${shop.id}/items/bulk`, {})).status, 400);
    const bad = await a.post(`/api/lists/${shop.id}/items/bulk`, { items: [{ text: 'ok' }, { text: '' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Item 2/);
    const tooMany = await a.post(`/api/lists/${shop.id}/items/bulk`, { items: Array.from({ length: 201 }, (_, i) => ({ text: `i${i}` })) });
    assert.equal(tooMany.status, 400);
    // Nothing from the failed batches was inserted (atomic).
    assert.equal((await a.get(`/api/lists/${shop.id}`)).body.items.length, 4);
    // Bulk adds are logged once on the Wall.
    const feed = (await a.get('/api/activity?module=lists')).body;
    assert.ok(feed.some((e) => e.summary === 'added 4 items to Groceries' && e.link === `/lists/${shop.id}`));
  });
});

describe('delete + restore (undo)', () => {
  test('delete is soft; restore brings back the original row silently', async () => {
    const fx = await familyFixture(srv, 'Undo');
    const a = fx.admin.agent;
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const task = (await fx.member.agent.post(`/api/lists/${todo.id}/items`, { text: 'Walk dog', assignee_id: fx.admin.user.id, due_date: '2026-10-02' })).body;
    await a.patch(`/api/lists/${todo.id}/items/${task.id}`, { done: true });
    flushPendingActivity();
    const noteCount = async () =>
      (await a.get('/api/notifications')).body.items.length + (await fx.member.agent.get('/api/notifications')).body.items.length;
    const notesBefore = await noteCount();
    const feedBefore = (await a.get('/api/activity?module=lists')).body.length;

    assert.equal((await a.del(`/api/lists/${todo.id}/items/${task.id}`)).status, 200);
    assert.equal((await a.get(`/api/lists/${todo.id}`)).body.items.length, 0);
    assert.equal((await a.patch(`/api/lists/${todo.id}/items/${task.id}`, { done: false })).status, 404);
    assert.equal((await a.get('/api/search?q=Walk%20dog')).body.results.filter((r) => r.module === 'lists').length, 0);

    const seen = await collectEvents(fx.member.agent, { until: (e) => e.type === 'lists.item.restored' });
    const restored = await a.post(`/api/lists/${todo.id}/items/${task.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.id, task.id);
    assert.equal(restored.body.created_by, fx.member.user.id);
    assert.equal(restored.body.created_at, task.created_at);
    assert.equal(restored.body.done, true);
    assert.equal(restored.body.done_by, fx.admin.user.id);
    assert.equal(restored.body.due_date, '2026-10-02');
    assert.equal(restored.body.position, task.position);
    assert.ok((await seen.events).some((e) => e.type === 'lists.item.restored'));
    flushPendingActivity();
    assert.equal(await noteCount(), notesBefore, 'restore sends no notifications');
    assert.equal((await a.get('/api/activity?module=lists')).body.length, feedBefore, 'restore adds no Wall entry');
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${task.id}/restore`)).status, 404);

    // Deleting + undoing within the batching window keeps the pending "added" entry.
    const kept = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Kept via undo' })).body;
    await a.del(`/api/lists/${todo.id}/items/${kept.id}`);
    await a.post(`/api/lists/${todo.id}/items/${kept.id}/restore`);
    flushPendingActivity();
    assert.ok((await a.get('/api/activity?module=lists')).body.some((e) => e.summary === 'added “Kept via undo” to Chores'));

    // Deleting right after adding cancels the pending "added" Wall entry.
    const oops = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Oops typo' })).body;
    await a.del(`/api/lists/${todo.id}/items/${oops.id}`);
    flushPendingActivity();
    assert.ok(!(await a.get('/api/activity?module=lists')).body.some((e) => e.summary.includes('Oops typo')));

    // Old soft-deleted rows are purged; a deleted list can't be restored into.
    assert.ok(purgeDeleted(srv.ctx, Date.now() + 2 * 86400_000) >= 1);
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${oops.id}/restore`)).status, 404);
    await a.del(`/api/lists/${todo.id}/items/${task.id}`);
    await a.del(`/api/lists/${todo.id}`);
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${task.id}/restore`)).status, 404);
  });

  test('search escapes LIKE wildcards', async () => {
    const fx = await familyFixture(srv, 'Like');
    const a = fx.admin.agent;
    const l = (await a.post('/api/lists', { name: 'Stuff', type: 'other' })).body;
    await a.post(`/api/lists/${l.id}/items`, { text: 'Sunscreen 50%' });
    await a.post(`/api/lists/${l.id}/items`, { text: 'Sunscreen 30' });
    const hits = (q) => a.get(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.body.results.filter((x) => x.module === 'lists').map((x) => x.title));
    assert.deepEqual(await hits('0%'), ['Sunscreen 50%']);
    assert.deepEqual(await hits('__'), []);
  });
});

describe('isolation and roles', () => {
  test('lists and items are family-scoped (404 across families)', async () => {
    const a = await familyFixture(srv, 'IsoA');
    const b = await familyFixture(srv, 'IsoB');
    const list = (await a.admin.agent.post('/api/lists', { name: 'Private', type: 'todo' })).body;
    const item = (await a.admin.agent.post(`/api/lists/${list.id}/items`, { text: 'Secret' })).body;
    const B = b.admin.agent;
    assert.equal((await B.get(`/api/lists/${list.id}`)).status, 404);
    assert.equal((await B.patch(`/api/lists/${list.id}`, { name: 'Hacked' })).status, 404);
    assert.equal((await B.del(`/api/lists/${list.id}`)).status, 404);
    assert.equal((await B.post(`/api/lists/${list.id}/items`, { text: 'Injected' })).status, 404);
    assert.equal((await B.post(`/api/lists/${list.id}/items/bulk`, { items: [{ text: 'x' }] })).status, 404);
    assert.equal((await B.patch(`/api/lists/${list.id}/items/${item.id}`, { done: true })).status, 404);
    assert.equal((await B.del(`/api/lists/${list.id}/items/${item.id}`)).status, 404);
    assert.equal((await B.post(`/api/lists/${list.id}/clear-completed`)).status, 404);
    assert.equal((await B.post(`/api/lists/${list.id}/duplicate`)).status, 404);
    assert.equal((await B.put(`/api/lists/${list.id}/items/order`, { ids: [item.id] })).status, 404);
    // Item id from another list of the same family is also 404.
    const other = (await a.admin.agent.post('/api/lists', { name: 'Other' })).body;
    assert.equal((await a.admin.agent.patch(`/api/lists/${other.id}/items/${item.id}`, { done: true })).status, 404);
    // Listing doesn't leak.
    assert.equal((await B.get('/api/lists')).body.length, 0);
    // Can't assign to someone outside the family.
    assert.equal((await a.admin.agent.post(`/api/lists/${list.id}/items`, { text: 'x', assignee_id: b.admin.user.id })).status, 400);
    // Search doesn't leak.
    const s = (await B.get('/api/search?q=Secret')).body;
    assert.equal(s.results.filter((r) => r.module === 'lists').length, 0);
    const s2 = (await a.admin.agent.get('/api/search?q=Secret')).body;
    assert.equal(s2.results.filter((r) => r.module === 'lists').length, 1);
  });

  test('children cannot delete or rename others’ lists or delete others’ items, but can check them', async () => {
    const fx = await familyFixture(srv, 'Roles');
    const kid = await addChild(fx, 'Mia');
    const parentList = (await fx.admin.agent.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const task = (await fx.admin.agent.post(`/api/lists/${parentList.id}/items`, { text: 'Clean room', assignee_id: kid.user.id })).body;
    const other = (await fx.admin.agent.post(`/api/lists/${parentList.id}/items`, { text: 'Mow lawn', assignee_id: fx.member.user.id })).body;

    const view = (await kid.agent.get(`/api/lists/${parentList.id}`)).body;
    assert.equal(view.can_manage, false);
    assert.equal(view.items.find((i) => i.id === task.id).can_edit, false);
    assert.equal(view.items.find((i) => i.id === other.id).can_edit, false);
    assert.equal(view.items.find((i) => i.id === other.id).can_delete, false);

    assert.equal((await kid.agent.del(`/api/lists/${parentList.id}`)).status, 403);
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}`, { name: 'Nope' })).status, 403);
    assert.equal((await kid.agent.post(`/api/lists/${parentList.id}/clear-completed`)).status, 403);
    assert.equal((await kid.agent.del(`/api/lists/${parentList.id}/items/${other.id}`)).status, 403);
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${other.id}`, { text: 'Skip' })).status, 403);
    // Checking off is fine; editing their own assigned task is fine.
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { done: true })).status, 200);
    // Notes: a child assignee can't overwrite the grown-up's notes, only append a signed note.
    await fx.admin.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { notes: 'Toys in the bin' });
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { notes: 'Done!' })).status, 403);
    const appended = await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { add_note: 'Done!' });
    assert.equal(appended.status, 200);
    assert.match(appended.body.notes, /^Toys in the bin\n— Mia · .+: Done!$/);
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${other.id}`, { add_note: 'x' })).status, 403);
    // As a mere assignee they can't move the due date or rename their chore, or reorder a parent's list.
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { due_date: '2030-01-01' })).status, 403);
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { due_date: null })).status, 403);
    assert.equal((await kid.agent.patch(`/api/lists/${parentList.id}/items/${task.id}`, { text: 'Skip it' })).status, 403);
    assert.equal(view.items.find((i) => i.id === task.id).can_edit_notes, true);
    assert.equal((await kid.agent.put(`/api/lists/${parentList.id}/items/order`, { ids: [other.id, task.id] })).status, 403);
    assert.equal((await fx.member.agent.put(`/api/lists/${parentList.id}/items/order`, { ids: [other.id, task.id] })).status, 200);
    // Kids can add items and delete their own; can't assign others.
    const mine = await kid.agent.post(`/api/lists/${parentList.id}/items`, { text: 'Feed fish' });
    assert.equal(mine.status, 201);
    assert.equal((await kid.agent.post(`/api/lists/${parentList.id}/items`, { text: 'x', assignee_id: fx.admin.user.id })).status, 403);
    assert.equal((await kid.agent.post(`/api/lists/${parentList.id}/items`, { text: 'Me', assignee_id: kid.user.id })).status, 201);
    assert.equal((await kid.agent.del(`/api/lists/${parentList.id}/items/${mine.body.id}`)).status, 200);
    // Their own list is theirs to manage.
    const own = (await kid.agent.post('/api/lists', { name: 'My stuff' })).body;
    assert.equal(own.can_manage, true);
    assert.equal((await kid.agent.del(`/api/lists/${own.id}`)).status, 200);
  });
});

describe('my tasks, dashboard, notifications', () => {
  test('my tasks groups by overdue / today / upcoming / someday, and the badge count', async () => {
    const fx = await familyFixture(srv, 'Tasks');
    const a = fx.admin.agent;
    const me = fx.admin.user.id;
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const shop = (await a.post('/api/lists', { name: 'Shop', type: 'shopping' })).body;
    const today = '2026-05-10';
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Late', assignee_id: me, due_date: '2026-05-08' });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Now', assignee_id: me, due_date: today });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Soon', assignee_id: me, due_date: '2026-05-12' });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Whenever', assignee_id: me });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Not mine', assignee_id: fx.member.user.id, due_date: today });
    const doneOne = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Finished', assignee_id: me, due_date: today })).body;
    await a.patch(`/api/lists/${todo.id}/items/${doneOne.id}`, { done: true });
    await a.post(`/api/lists/${shop.id}/items`, { text: 'Milk', assignee_id: me, due_date: today }); // shopping excluded

    const res = await a.get(`/api/lists/my-tasks?today=${today}`);
    assert.equal(res.status, 200);
    const names = (g) => res.body[g].map((i) => i.text);
    assert.deepEqual(names('overdue'), ['Late']);
    assert.deepEqual(names('today'), ['Now']);
    assert.deepEqual(names('upcoming'), ['Soon']);
    assert.deepEqual(names('someday'), ['Whenever']);
    assert.equal(res.body.today[0].list_name, 'Chores');

    const count = (await a.get(`/api/lists/my-tasks/count?today=${today}`)).body;
    assert.deepEqual(count, { overdue: 1, today: 1, open: 4, attention: 2 });

    const theirs = (await a.get(`/api/lists/my-tasks?today=${today}&user_id=${fx.member.user.id}`)).body;
    assert.deepEqual(theirs.today.map((i) => i.text), ['Not mine']);
    const outsider = await familyFixture(srv, 'Tasks-out');
    assert.equal((await a.get(`/api/lists/my-tasks?user_id=${outsider.admin.user.id}`)).status, 404);

    // Dashboard contract.
    const dash = (await a.get(`/api/dashboard?today=${today}`)).body.lists;
    assert.deepEqual(dash.due.map((i) => i.text), ['Now']);
    assert.deepEqual(dash.overdue.map((i) => i.text), ['Late']);
    for (const k of ['id', 'list_id', 'list_name', 'text', 'due_date', 'assignee_id']) assert.ok(k in dash.due[0], k);
    assert.deepEqual(dash.lists.map((l) => [l.name, l.type, l.open_count]), [['Chores', 'todo', 5], ['Shop', 'shopping', 1]]);
  });

  test('assigning notifies the assignee; finishing notifies the creator; nudges are throttled', async () => {
    const fx = await familyFixture(srv, 'Notify');
    const a = fx.admin.agent;
    const m = fx.member.agent;
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const task = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Walk the dog', assignee_id: fx.member.user.id })).body;
    let notes = (await m.get('/api/notifications')).body.items.filter((n) => n.module === 'lists');
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /assigned you a task/);
    assert.match(notes[0].body, /Walk the dog/);
    assert.equal(notes[0].link, `/lists/${todo.id}?item=${task.id}`);

    // Self-assignment doesn't notify.
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Mine', assignee_id: fx.admin.user.id });
    assert.equal((await a.get('/api/notifications')).body.items.filter((n) => n.module === 'lists').length, 0);

    // Nudge.
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${task.id}/remind`)).status, 200);
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${task.id}/remind`)).status, 429);
    notes = (await m.get('/api/notifications')).body.items.filter((n) => n.module === 'lists');
    assert.equal(notes.length, 2);
    assert.match(notes[0].title, /reminder/);

    // Completing notifies the creator.
    await m.patch(`/api/lists/${todo.id}/items/${task.id}`, { done: true });
    const adminNotes = (await a.get('/api/notifications')).body.items.filter((n) => n.module === 'lists');
    assert.equal(adminNotes.length, 1);
    assert.match(adminNotes[0].title, /finished a task/);
    assert.equal((await a.post(`/api/lists/${todo.id}/items/${task.id}/remind`)).status, 400);
  });

  test('due reminders use the assignee’s time zone, go out from 8am local, once per task', async () => {
    const fx = await familyFixture(srv, 'Due');
    const a = fx.admin.agent;
    srv.db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('America/Denver', fx.member.user.id);
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    // 2026-03-10 06:30 in Denver (MDT, UTC-6) = 12:30 UTC; 09:00 Denver = 15:00 UTC.
    const early = new Date('2026-03-10T12:30:00Z');
    const later = new Date('2026-03-10T15:00:00Z');
    const today = '2026-03-10';
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Today task', assignee_id: fx.member.user.id, due_date: today });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Late task', assignee_id: fx.member.user.id, due_date: addDays(today, -3) });
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Future task', assignee_id: fx.member.user.id, due_date: addDays(today, 1) });
    const reminders = async () => (await fx.member.agent.get('/api/notifications')).body.items.filter((n) => /^(Due today|Overdue):/.test(n.title));
    assert.equal(sendDueReminders(srv.ctx, early), 0, 'nothing before 8am local');
    assert.equal((await reminders()).length, 0);
    sendDueReminders(srv.ctx, later);
    sendDueReminders(srv.ctx, later);
    assert.deepEqual((await reminders()).map((n) => n.title).sort(), ['Due today: Today task', 'Overdue: Late task']);
    // Changing the due date re-arms the reminder.
    const fut = (await a.get(`/api/lists/${todo.id}`)).body.items.find((i) => i.text === 'Future task');
    await a.patch(`/api/lists/${todo.id}/items/${fut.id}`, { due_date: today });
    sendDueReminders(srv.ctx, later);
    assert.equal((await reminders()).length, 3);
  });

  test('“today” follows the X-Timezone header', async () => {
    const fx = await familyFixture(srv, 'Tz');
    const a = fx.admin.agent;
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const kiri = srv.ctx.time.dateIn('Pacific/Kiritimati'); // UTC+14
    await a.post(`/api/lists/${todo.id}/items`, { text: 'Kiri task', assignee_id: fx.admin.user.id, due_date: kiri });
    const east = (await a.get('/api/lists/my-tasks', { headers: { 'x-timezone': 'Pacific/Kiritimati' } })).body;
    const west = (await a.get('/api/lists/my-tasks', { headers: { 'x-timezone': 'Pacific/Pago_Pago' } })).body; // UTC-11
    assert.deepEqual(east.today.map((i) => i.text), ['Kiri task']);
    assert.deepEqual(west.upcoming.map((i) => i.text), ['Kiri task']);
    const dash = (await a.get('/api/dashboard', { headers: { 'x-timezone': 'Pacific/Kiritimati' } })).body.lists;
    assert.deepEqual(dash.due.map((i) => i.text), ['Kiri task']);
  });

  test('Wall activity is batched per user and list', async () => {
    const fx = await familyFixture(srv, 'Activity');
    const a = fx.admin.agent;
    const shop = (await a.post('/api/lists', { name: 'Groceries', type: 'shopping' })).body;
    const todo = (await a.post('/api/lists', { name: 'Chores', type: 'todo' })).body;
    const ids = [];
    for (const t of ['Milk', 'Eggs', 'Bread']) ids.push((await a.post(`/api/lists/${shop.id}/items`, { text: t })).body.id);
    const task = (await a.post(`/api/lists/${todo.id}/items`, { text: 'Dishes' })).body;
    await a.patch(`/api/lists/${shop.id}/items/${ids[0]}`, { done: true });
    await a.patch(`/api/lists/${shop.id}/items/${ids[1]}`, { done: true });
    await a.patch(`/api/lists/${todo.id}/items/${task.id}`, { done: true });
    await a.patch(`/api/lists/${todo.id}/items/${task.id}`, { done: false }); // cancels the pending entry
    flushPendingActivity();
    const feed = (await a.get('/api/activity?module=lists')).body.map((e) => e.summary);
    assert.ok(feed.includes('created the shopping list 🛒 Groceries'));
    assert.ok(feed.includes('added 3 items to Groceries'));
    assert.ok(feed.includes('added “Dishes” to Chores'));
    assert.ok(feed.includes('checked off 2 items on Groceries'));
    assert.ok(!feed.some((s) => s.startsWith('completed')));
  });
});

describe('realtime', () => {
  test('mutations broadcast lists.* events to the family only', async () => {
    const fx = await familyFixture(srv, 'Live');
    const outsider = await familyFixture(srv, 'Live-out');
    const a = fx.admin.agent;
    const want = ['lists.created', 'lists.item.created', 'lists.item.updated', 'lists.items.bulk', 'lists.items.reordered', 'lists.item.deleted', 'lists.updated', 'lists.deleted'];
    const seen = await collectEvents(fx.member.agent, { until: (e) => e.type === 'lists.deleted', timeoutMs: 5000 });
    const leak = await collectEvents(outsider.admin.agent, { until: (e) => e.type.startsWith('lists.'), timeoutMs: 1500 });
    const l = (await a.post('/api/lists', { name: 'Live list', type: 'shopping' })).body;
    const it = (await a.post(`/api/lists/${l.id}/items`, { text: 'Apples' })).body;
    await a.patch(`/api/lists/${l.id}/items/${it.id}`, { done: true });
    const bulk = (await a.post(`/api/lists/${l.id}/items/bulk`, { items: [{ text: 'Pears' }] })).body;
    await a.put(`/api/lists/${l.id}/items/order`, { ids: [bulk.items[0].id, it.id] });
    await a.del(`/api/lists/${l.id}/items/${it.id}`);
    await a.patch(`/api/lists/${l.id}`, { name: 'Renamed' });
    await a.del(`/api/lists/${l.id}`);
    const events = (await seen.events).filter((e) => e.type.startsWith('lists.'));
    assert.deepEqual(events.map((e) => e.type), want);
    assert.equal(events[1].payload.list_id, l.id);
    assert.equal(events[1].payload.item.text, 'Apples');
    assert.equal(events[1].payload.by, fx.admin.user.id);
    assert.equal((await leak.events).length, 0);
  });
});

describe('seed', () => {
  test('demo seed creates Groceries, Weekend chores and a packing list', async () => {
    const s = await startServer();
    try {
      const { familyId, users } = await seedDemo(s.ctx, undefined, { log: () => {} });
      const lists = s.db.prepare('SELECT * FROM lists WHERE family_id = ? ORDER BY position').all(familyId);
      const names = lists.map((l) => l.name);
      assert.ok(names.includes('Groceries'));
      assert.ok(names.includes('Weekend chores'));
      assert.ok(names.some((n) => n.startsWith('Packing list')));
      const groceries = lists.find((l) => l.name === 'Groceries');
      assert.equal(groceries.type, 'shopping');
      const cats = s.db.prepare('SELECT DISTINCT category FROM list_items WHERE list_id = ?').all(groceries.id).map((r) => r.category);
      assert.ok(cats.length >= 6, `expected several aisles, got ${cats}`);
      const chores = lists.find((l) => l.name === 'Weekend chores');
      const kidTasks = s.db
        .prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ? AND assignee_id IN (?, ?)')
        .get(chores.id, users.mia.id, users.leo.id).n;
      assert.ok(kidTasks >= 4);
      // Alex has something overdue / due today for the dashboard + badge.
      const alex = s.agent();
      await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: 'hearth123' });
      const count = (await alex.get('/api/lists/my-tasks/count')).body;
      assert.ok(count.overdue >= 1 && count.today >= 1);
      const dash = (await alex.get('/api/dashboard')).body.lists;
      assert.ok(dash.due.length >= 1 && dash.overdue.length >= 1 && dash.lists.length >= 3);
      // Re-seeding is idempotent-ish (recreates the family cleanly).
      const itemCount = s.db.prepare('SELECT COUNT(*) AS n FROM list_items').get().n;
      await seedDemo(s.ctx, undefined, { log: () => {} });
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM lists').get().n, lists.length);
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM list_items').get().n, itemCount);
    } finally {
      await s.close();
    }
  });
});
