import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, familyFixture, PNG_1X1, collectEvents } from './helpers.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { addDays, mondayOf, localDateKey } from '../src/modules/meals.js';
import { aggregateIngredients, parseIngredientLine, fmtQty, guessCategory, nameKey, ingredientText } from '../src/modules/meals/shopping.js';
import { dateIn } from '../src/time.js';
import * as shared from '../../shared/meals/ingredients.js';
import { sameGrocery } from '../../shared/meals/match.js';
import { createClassifier } from '../../shared/lists/classify.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

const recipeBody = (over = {}) => ({
  title: 'Weeknight Chili',
  description: 'Cozy and quick',
  servings: 4,
  prep_minutes: 10,
  cook_minutes: 30,
  tags: ['Dinner', ' Batch Cook ', 'dinner'],
  icon: 'soup',
  color: '#E5484D',
  ingredients: [
    { quantity: 500, unit: 'g', name: 'ground beef' },
    { quantity: 1, unit: 'can', name: 'kidney beans', note: 'drained' },
    '2 tbsp chili powder',
    { quantity: '', unit: '', name: '' }, // blank rows are ignored
  ],
  steps: ['Brown the beef.', '  ', 'Add everything and simmer.'],
  ...over,
});

async function addChild(fx, name = 'Kid') {
  const email = `kid${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  const created = await fx.admin.agent.post('/api/family/members', { name, role: 'child', email, password: 'secret123' });
  assert.equal(created.status, 201);
  const agent = srv.agent();
  assert.equal((await agent.post('/api/auth/login', { email, password: 'secret123' })).status, 200);
  return { agent, user: created.body };
}

describe('shopping helpers', () => {
  test('parseIngredientLine handles fractions, units and notes', () => {
    assert.deepEqual(parseIngredientLine('1 1/2 cups flour, sifted'), { quantity: 1.5, unit: 'cup', name: 'flour', note: 'sifted' });
    assert.deepEqual(parseIngredientLine('½ tsp salt'), { quantity: 0.5, unit: 'tsp', name: 'salt', note: null });
    assert.deepEqual(parseIngredientLine('3 eggs'), { quantity: 3, unit: null, name: 'eggs', note: null });
    assert.deepEqual(parseIngredientLine('Salt and pepper'), { quantity: null, unit: null, name: 'Salt and pepper', note: null });
    assert.deepEqual(parseIngredientLine('2 T olive oil (extra virgin)'), { quantity: 2, unit: 'tbsp', name: 'olive oil', note: 'extra virgin' });
    assert.equal(parseIngredientLine('   '), null);
  });

  test('parseIngredientLine table: fractions, mixed numbers, decimals, ranges, package sizes', () => {
    const cases = [
      ['1/2 cup parmesan', 0.5, 'cup', 'parmesan', null],
      ['3/4 tsp salt', 0.75, 'tsp', 'salt', null],
      ['1/3 cup sugar', 0.333, 'cup', 'sugar', null],
      ['2/3 cup milk', 0.667, 'cup', 'milk', null],
      ['1/4 onion', 0.25, null, 'onion', null],
      ['1 1/2 cups flour', 1.5, 'cup', 'flour', null],
      ['2 3/4 cups oats', 2.75, 'cup', 'oats', null],
      ['½ tsp cumin', 0.5, 'tsp', 'cumin', null],
      ['1½ cups milk', 1.5, 'cup', 'milk', null],
      ['1 ½ cups milk', 1.5, 'cup', 'milk', null],
      ['0.5 kg beef', 0.5, 'kg', 'beef', null],
      ['1,5 l stock', 1.5, 'l', 'stock', null],
      ['1.25 cups water', 1.25, 'cup', 'water', null],
      ['2-3 cloves garlic', 3, 'clove', 'garlic', '2–3'],
      ['2 – 3 carrots', 3, null, 'carrots', '2–3'],
      ['1 to 2 tbsp honey', 2, 'tbsp', 'honey', '1–2'],
      ['1 (14 oz) can black beans', 1, 'can', 'black beans', '14 oz'],
      ['2 (400 g) tins tomatoes, drained', 2, 'can', 'tomatoes', '400 g, drained'],
      ['2 x 400g cans tomatoes', 2, 'can', 'tomatoes', '400 g each'],
      ['3 × 200 ml cartons cream', 3, null, 'cartons cream', '200 ml each'],
      ['400g flour', 400, 'g', 'flour', null],
      ['500 ml milk', 500, 'ml', 'milk', null],
      ['3 eggs', 3, null, 'eggs', null],
      ['2 T olive oil (extra virgin)', 2, 'tbsp', 'olive oil', 'extra virgin'],
      ['1 c flour', 1, 'cup', 'flour', null],
      ['1 1/2 cups flour, sifted', 1.5, 'cup', 'flour', 'sifted'],
      ['Salt and pepper', null, null, 'Salt and pepper', null],
      ['T-bone steak', null, null, 'T-bone steak', null],
      ['- 2 tablespoons butter', 2, 'tbsp', 'butter', null],
      ['1 pound ground beef', 1, 'lb', 'ground beef', null],
      ['4 garlic cloves', 4, 'clove', 'garlic', null],
      ['2 cloves garlic', 2, 'clove', 'garlic', null],
      ['3 celery stalks', 3, 'stalk', 'celery', null],
      ['2 stalks celery', 2, 'stalk', 'celery', null],
      ['4 thyme sprigs', 4, 'sprig', 'thyme', null],
      ['1 garlic bulb', 1, 'bulb', 'garlic', null],
      ['1 tsp ground cloves', 1, 'tsp', 'ground cloves', null],
      ['6 whole cloves', 6, null, 'whole cloves', null],
      ['1 cup (240 ml) water', 1, 'cup', 'water', '240 ml'],
      ['1 can (400 g) chickpeas, rinsed', 1, 'can', 'chickpeas', '400 g, rinsed'],
      ['8 fl oz cream', 8, 'fl oz', 'cream', null],
      ['salt to taste', null, null, 'salt', 'to taste'],
    ];
    for (const [line, quantity, unit, name, note] of cases) {
      assert.deepEqual(parseIngredientLine(line), { quantity, unit, name, note }, line);
    }
    assert.equal(parseIngredientLine('   '), null);
    // The editor's amount field uses the same parser: "1/2" must store 0.5 (not 1).
    for (const [v, want] of [['1/2', 0.5], ['3/4', 0.75], ['1 1/2', 1.5], ['½', 0.5], ['0,5', 0.5], ['2', 2]]) {
      assert.equal(shared.parseIngredientLine(`${v} x`).quantity, want, v);
      assert.equal(shared.parseAmount(v).value, want, v);
    }
    // Server and client share the very same module.
    assert.equal(parseIngredientLine, shared.parseIngredientLine);
  });

  test('aggregateIngredients merges names/units, scales and converts', () => {
    const items = aggregateIngredients([
      { name: 'Tomatoes', quantity: 2, unit: null, factor: 1, recipe_title: 'A' },
      { name: 'tomato', quantity: 1, unit: null, factor: 2, recipe_title: 'B' },
      { name: 'flour', quantity: 600, unit: 'g', factor: 1, recipe_title: 'A' },
      { name: 'Flour', quantity: 0.5, unit: 'kg', factor: 1, recipe_title: 'B' },
      { name: 'milk', quantity: 1, unit: 'cups', factor: 1, recipe_title: 'A' },
      { name: 'milk', quantity: 0.5, unit: 'cup', factor: 1, recipe_title: 'B' },
      { name: 'salt', quantity: null, unit: null, factor: 1, recipe_title: 'A' },
      { name: 'Salt', quantity: 1, unit: 'tsp', factor: 1, recipe_title: 'B' },
    ]);
    const by = Object.fromEntries(items.map((i) => [i.text, i]));
    assert.ok(by['4 Tomatoes'], JSON.stringify(items.map((i) => i.text)));
    assert.deepEqual(by['4 Tomatoes'].recipes, ['A', 'B']);
    assert.ok(by['1.1 kg flour']);
    assert.ok(by['1½ cups milk']);
    assert.ok(by['1 tsp Salt'], 'unquantified salt folds into the quantified line');
    assert.equal(items.length, 4);
    assert.equal(by['4 Tomatoes'].category, 'Produce');
    assert.equal(fmtQty(0.333), '⅓');
    assert.equal(nameKey('Cherries'), 'cherry');
  });

  test('sameGrocery: conservative "already on the list" matching', () => {
    const aisleOf = createClassifier(JSON.parse(fs.readFileSync(new URL('../../shared/lists/aisles.json', import.meta.url), 'utf8'))).guessCategory;
    const yes = [['Cheddar', 'Cheddar cheese'], ['Small tortillas', 'Tortillas'], ['Avocados', 'avocado'], ['Red onion', 'Onion'],
      ['Baby spinach', 'Spinach'], ['Eggs', 'egg'], ['Crème fraîche', 'creme fraiche'], ['Large eggs', 'Eggs']];
    const no = [['Pepper', 'Black pepper'], ['Tomato', 'Tomato sauce'], ['Eggs', 'Egg yolk'], ['Milk', 'Almond milk'],
      ['Potato', 'Sweet potatoes'], ['Onions', 'Green onions'], ['Garlic', 'Garlic bread'], ['Cream', 'Sour cream'], ['Butter', 'Peanut butter'], ['Rice', 'Rice noodles']];
    for (const [a, b] of yes) assert.equal(sameGrocery(a, b, aisleOf), true, `${a} ≈ ${b}`);
    for (const [a, b] of no) assert.equal(sameGrocery(a, b, aisleOf), false, `${a} ≠ ${b}`);
  });

  test('guessCategory: head nouns, specific phrases first, plurals (table)', () => {
    const table = {
      Produce: ['blueberries', 'mixed berries', 'ripe bananas', 'lemon', '2 limes', 'red onion', 'shallots', 'garlic', 'fresh ginger',
        'cherry tomatoes', 'tomatoes', 'baby potatoes', 'sweet potato', 'carrot', 'celery stalks', 'red bell pepper', 'cucumber',
        'romaine lettuce', 'baby spinach', 'avocado', 'zucchini', 'broccoli', 'mushrooms', 'fresh basil', 'cilantro', 'spring onions',
        'asparagus', 'leeks', 'jalapeño peppers', 'jalapeños', 'garlic cloves'],
      'Meat & Fish': ['chicken thighs', 'chicken breast', 'ground beef', 'pork chops sausage', 'bacon', 'salmon fillets', 'shrimp', 'cod', 'turkey mince'],
      'Dairy & Eggs': ['firm tofu', 'eggs', 'milk', 'heavy cream', 'butter', 'parmesan', 'mozzarella', 'cheddar', 'feta', 'greek yogurt', 'sour cream', 'cream cheese', 'buttermilk'],
      Bakery: ['small tortillas', 'burger buns', 'baguette', 'pita bread', 'naan', 'english muffins'],
      Pantry: ['egg noodles', 'rice noodles', 'coconut milk', 'rolled oats', 'bread flour', 'flour', 'chia seeds', 'sesame seeds', 'kalamata olives',
        'crushed tomatoes', 'chopped tomatoes', 'canned tomatoes', 'tomato paste', 'passata', 'chicken stock', 'vegetable broth', 'soy sauce',
        'olive oil', 'sesame oil', 'honey', 'maple syrup', 'mild curry paste', 'basmati rice', 'penne pasta', 'brown sugar', 'sugar',
        'baking powder', 'dried yeast', 'vanilla extract', 'chocolate chips', 'peanut butter', 'kidney beans', 'chickpeas', 'breadcrumbs'],
      Spices: ['salt', 'black pepper', 'salt and black pepper', 'smoked paprika', 'cumin', 'dried oregano', 'cinnamon', 'chili powder', 'bay leaves',
        'pepper', 'chili flakes', 'chilli flakes', 'red pepper flakes'],
      Frozen: ['frozen peas', 'vanilla ice cream'],
    };
    let n = 0;
    const wrong = [];
    for (const [cat, names] of Object.entries(table)) {
      for (const name of names) {
        n++;
        if (guessCategory(name) !== cat) wrong.push(`${name}: ${guessCategory(name)} (want ${cat})`);
      }
    }
    assert.ok(n >= 60, `table has ${n} items`);
    assert.deepEqual(wrong, []);
  });

  test('bare counts pluralise, water is dropped, same ingredient in two units merges', () => {
    assert.equal(ingredientText({ quantity: 6, unit: null, name: 'egg' }), '6 eggs');
    assert.equal(ingredientText({ quantity: 3, unit: null, name: 'lemon' }), '3 lemons');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'tomato' }), '2 tomatoes');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'red bell pepper' }), '2 red bell peppers');
    assert.equal(ingredientText({ quantity: 4, unit: null, name: 'salmon fillets' }), '4 salmon fillets');
    assert.equal(ingredientText({ quantity: 1, unit: null, name: 'Tomatoes' }), '1 Tomato');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'asparagus' }), '2 asparagus');
    assert.equal(ingredientText({ quantity: 2, unit: 'cup', name: 'blueberries' }), '2 cups blueberries');
    assert.equal(ingredientText({ quantity: 3, unit: null, name: 'berry' }), '3 berries');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'jalapeños' }), '2 jalapeños');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'jalapeño' }), '2 jalapeños');
    assert.equal(ingredientText({ quantity: 3, unit: null, name: 'crème brûlée' }), '3 crème brûlées');
    assert.equal(ingredientText({ quantity: 2, unit: null, name: 'peaches' }), '2 peaches');
    assert.equal(ingredientText({ quantity: 1, unit: null, name: 'jalapeños' }), '1 jalapeño');
    const merged = aggregateIngredients([
      { name: 'bay leaves', quantity: 2, unit: null }, { name: 'bay leaf', quantity: 1, unit: null },
      { name: 'ground beef', quantity: 500, unit: 'g' }, { name: 'ground beef', quantity: 1, unit: 'lb' },
    ]).map((i) => i.text);
    assert.deepEqual(merged, ['954 g ground beef', '3 bay leaves']);
    const rows = (lines) => lines.map((l) => ({ ...parseIngredientLine(l), factor: 1, recipe_title: 'R' }));
    const texts = (lines) => aggregateIngredients(rows(lines)).map((i) => `${i.category}: ${i.text}`);
    // garlic in cloves, either word order, merges (and is produce, not the spice)
    assert.deepEqual(texts(['4 garlic cloves', '2 cloves garlic', '1 tsp ground cloves', 'cloves']),
      ['Produce: 6 cloves garlic', 'Pantry: cloves', 'Pantry: 1 tsp ground cloves']);
    assert.deepEqual(texts(['3 celery stalks', '2 stalks celery']), ['Produce: 5 stalks celery']);
    // liquids across volume units: metric when any input is metric, US otherwise; water is never listed
    assert.deepEqual(texts(['1 cup milk', '250 ml milk', '1 l milk', '1 cup (240 ml) water', '2 cups water']), ['Dairy: 1.49 l milk']);
    assert.deepEqual(texts(['2 tbsp olive oil', '1/4 cup olive oil']), ['Pantry: ⅜ cup olive oil']);
    assert.deepEqual(texts(['1 tbsp soy sauce', '1 tsp soy sauce']), ['Pantry: 1.5 tbsp soy sauce'.replace('1.5', '1½')]);
    assert.deepEqual(texts(['1 cup chicken stock', '500 ml chicken stock']), ['Pantry: 735 ml chicken stock']);
    assert.deepEqual(texts(['1 cup sour cream', '100 ml sour cream']).length, 2, 'sour cream is not summed across metric like a liquid');
    assert.deepEqual(texts(['1 cup sour cream', '2 tbsp sour cream']), ['Dairy: 1⅛ cups sour cream'], 'but US spoons + cups add up');
    // anything canned is pantry, even when the fresh version is produce
    // aisles are the Lists module's canonical ones (no "Dairy & Eggs"/"Spices" look-alikes); metric amounts use decimals
    const aisles = new Set(JSON.parse(fs.readFileSync(new URL('../../shared/lists/aisles.json', import.meta.url), 'utf8')).categories);
    const all = aggregateIngredients(rows(['164 g butter', '3 egg', '1 dozen eggs', '3 ribs celery', '1 tsp cumin', '1 lb chicken thighs', '1 glass of wine', '1.375 kg flour', '1 3/8 cups sugar']));
    assert.ok(all.every((i) => aisles.has(i.category)), JSON.stringify(all.map((i) => i.category)));
    const by = Object.fromEntries(all.map((i) => [i.text, i]));
    assert.deepEqual([by['164 g butter'].label, by['164 g butter'].amount, by['164 g butter'].category], ['Butter', '164 g', 'Dairy']);
    assert.deepEqual([by['15 eggs'].label, by['15 eggs'].amount], ['Eggs', '15'], '3 eggs + 1 dozen eggs');
    assert.deepEqual([by['3 stalks celery'].label, by['3 stalks celery'].amount, by['3 stalks celery'].category], ['Celery', '3 stalks', 'Produce']);
    assert.equal(by['1 tsp cumin'].category, 'Pantry');
    assert.equal(by['1 lb chicken thighs'].category, 'Meat');
    assert.equal(by['1 glass of wine'].category, 'Drinks', 'Lists classifier fills in what meals does not know');
    assert.ok(by['1.38 kg flour'], 'decimals for metric, not "1⅜ kg"');
    assert.ok(by['1⅜ cups sugar'], 'fractions for cups');
    // dozens add up with bare counts; big spoon totals become cups; "salt and pepper" splits and merges
    assert.deepEqual(texts(['2 eggs', '1 dozen eggs']), ['Dairy: 14 eggs']);
    assert.deepEqual(texts(['11 tbsp olive oil']), ['Pantry: ⅔ cup olive oil']);
    assert.deepEqual(texts(['6 tbsp olive oil', '5 tbsp olive oil']), ['Pantry: ⅔ cup olive oil']);
    assert.deepEqual(texts(['12 tsp sugar']), ['Pantry: ¼ cup sugar']);
    assert.deepEqual(texts(['2 tbsp sugar', '1 cup sugar']), ['Pantry: 1⅛ cups sugar'], 'US volumes of dry goods merge too');
    assert.deepEqual(texts(['2 tbsp flour', '100 g flour']), ['Pantry: 116 g flour']);
    assert.deepEqual(texts(['Salt and black pepper', '1 tsp salt', '1/2 tsp black pepper']), ['Pantry: ½ tsp black pepper', 'Pantry: 1 tsp salt']);
    assert.deepEqual(texts(['3 tomatoes', '2 x 400g cans tomatoes', '1 can diced tomatoes', '2 jalapeños', '1 jar salsa']),
      ['Produce: 2 jalapeños', 'Produce: 3 tomatoes', 'Pantry: 1 can diced tomatoes', 'Pantry: 1 jar salsa', 'Pantry: 2 cans tomatoes']);
    const items = aggregateIngredients([
      { name: 'butter', quantity: 80, unit: 'g', recipe_title: 'Bread' },
      { name: 'butter', quantity: 3, unit: 'tbsp', recipe_title: 'Pancakes' },
      { name: 'warm water', quantity: 325, unit: 'ml', recipe_title: 'Pizza' },
      { name: 'olive oil', quantity: 2, unit: 'tbsp', recipe_title: 'Pizza' },
      { name: 'olive oil', quantity: 0.25, unit: 'cup', recipe_title: 'Salad' },
    ]);
    assert.deepEqual(items.map((i) => i.text), ['122 g butter', '⅜ cup olive oil']);
    assert.deepEqual(items[0].recipes, ['Bread', 'Pancakes']);
  });
});

describe('recipes', () => {
  let fx;
  let other;
  before(async () => {
    fx = await familyFixture(srv, 'Recipes A');
    other = await familyFixture(srv, 'Recipes B');
  });

  test('create, read, list, update and delete a recipe', async () => {
    const created = await fx.admin.agent.post('/api/meals/recipes', recipeBody());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const r = created.body;
    assert.equal(r.title, 'Weeknight Chili');
    assert.deepEqual(r.tags, ['dinner', 'batch cook']);
    assert.deepEqual(r.steps, ['Brown the beef.', 'Add everything and simmer.']);
    assert.equal(r.ingredients.length, 3);
    assert.deepEqual(r.ingredients[2], { id: r.ingredients[2].id, quantity: 2, unit: 'tbsp', name: 'chili powder', note: null });
    assert.equal(r.total_minutes, 40);
    assert.equal(r.created_by, fx.admin.user.id);

    const list = await fx.member.agent.get('/api/meals/recipes');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].ingredient_count, 3);
    assert.equal(list.body[0].step_count, 2);

    const patched = await fx.member.agent.patch(`/api/meals/recipes/${r.id}`, {
      title: 'Best Chili', servings: 6, ingredients: [{ quantity: 1, unit: 'kg', name: 'beef' }], steps: ['One step'],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.title, 'Best Chili');
    assert.equal(patched.body.servings, 6);
    assert.equal(patched.body.description, 'Cozy and quick', 'partial update keeps other fields');
    assert.equal(patched.body.ingredients.length, 1);
    assert.deepEqual(patched.body.tags, ['dinner', 'batch cook']);

    const tags = await fx.admin.agent.get('/api/meals/recipes/tags');
    assert.deepEqual(tags.body, [{ tag: 'batch cook', count: 1 }, { tag: 'dinner', count: 1 }]);

    assert.equal((await fx.admin.agent.del(`/api/meals/recipes/${r.id}`)).status, 200);
    assert.equal((await fx.admin.agent.get(`/api/meals/recipes/${r.id}`)).status, 404);
  });

  test('validation errors are friendly 400s', async () => {
    const a = fx.admin.agent;
    const cases = [
      [{ title: '' }, /Title is required/],
      [{ title: 'x'.repeat(121) }, /too long/],
      [{ servings: 0 }, /Servings/],
      [{ prep_minutes: -5 }, /Prep time/],
      [{ tags: 'dinner' }, /Tags must be a list/],
      [{ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }, /12 tags/],
      [{ ingredients: [{ quantity: 2, name: '' }] }, /needs a name/],
      [{ ingredients: [{ quantity: 'lots', name: 'salt' }] }, /Invalid quantity/],
      [{ steps: [42] }, /Step must be text/],
      [{ icon: 'rocket' }, /Unknown icon/],
      [{ color: 'red' }, /hex color/],
      [{ source_url: 'javascript:alert(1)' }, /http/],
    ];
    for (const [over, re] of cases) {
      const res = await a.post('/api/meals/recipes', recipeBody(over));
      assert.equal(res.status, 400, JSON.stringify(over));
      assert.match(res.body.error, re);
    }
    assert.equal((await a.get('/api/meals/recipes/abc')).status, 400);
  });

  test('search, tag and favorites filters', async () => {
    const a = fx.admin.agent;
    const pancakes = (await a.post('/api/meals/recipes', recipeBody({ title: 'Pancakes', tags: ['breakfast'], ingredients: ['2 cups flour', '2 eggs'] }))).body;
    const soup = (await a.post('/api/meals/recipes', recipeBody({ title: 'Tomato Soup', tags: ['lunch'], ingredients: ['4 tomatoes'] }))).body;
    assert.deepEqual((await a.get('/api/meals/recipes?q=flour')).body.map((r) => r.id), [pancakes.id], 'searches ingredients');
    assert.deepEqual((await a.get('/api/meals/recipes?tag=lunch')).body.map((r) => r.id), [soup.id]);
    assert.deepEqual((await a.get('/api/meals/recipes?sort=title')).body.map((r) => r.title), ['Pancakes', 'Tomato Soup']);

    const fav = await fx.member.agent.put(`/api/meals/recipes/${soup.id}/favorite`, { favorite: true });
    assert.equal(fav.status, 200);
    assert.deepEqual(fav.body.favorited_by, [fx.member.user.id]);
    assert.deepEqual((await fx.member.agent.get('/api/meals/recipes?favorites=1')).body.map((r) => r.id), [soup.id]);
    assert.deepEqual((await a.get('/api/meals/recipes?favorites=1')).body, [], 'favorites are per person');
    const detail = (await a.get(`/api/meals/recipes/${soup.id}`)).body;
    assert.equal(detail.favorite, false);
    assert.deepEqual(detail.favorited_by, [fx.member.user.id]);
    assert.equal((await fx.member.agent.put(`/api/meals/recipes/${soup.id}/favorite`, { favorite: 'yes' })).status, 400);
    await fx.member.agent.put(`/api/meals/recipes/${soup.id}/favorite`, { favorite: false });
    assert.deepEqual((await fx.member.agent.get('/api/meals/recipes?favorites=1')).body, []);

    const found = await a.get('/api/search?q=tomato');
    assert.ok(found.body.results.some((x) => x.module === 'meals' && x.link === `/meals/recipes/${soup.id}`));
    assert.equal((await other.admin.agent.get('/api/search?q=tomato')).body.results.filter((x) => x.module === 'meals').length, 0);
  });

  test('recipe photos: upload, replace, remove, type check', async () => {
    const a = fx.admin.agent;
    const r = (await a.post('/api/meals/recipes', recipeBody({ title: 'Photo dish' }))).body;
    const up = await a.upload(`/api/meals/recipes/${r.id}/photo`, { file: PNG_1X1, filename: 'dish.png' });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.match(up.body.photo_url, new RegExp(`^/uploads/${fx.family.id}/`));
    const file1 = path.join(srv.dir, 'uploads', up.body.photo_url.replace('/uploads/', ''));
    assert.ok(fs.existsSync(file1));
    const img = await a.get(up.body.photo_url);
    assert.equal(img.status, 200);

    const bad = await a.upload(`/api/meals/recipes/${r.id}/photo`, { file: Buffer.from('hello'), filename: 'x.txt', type: 'text/plain' });
    assert.equal(bad.status, 400);
    const heic = await a.upload(`/api/meals/recipes/${r.id}/photo`, { file: PNG_1X1, filename: 'x.heic', type: 'image/heic' });
    assert.equal(heic.status, 400, 'browsers cannot show HEIC');

    const up2 = await a.upload(`/api/meals/recipes/${r.id}/photo`, { file: PNG_1X1, filename: 'dish2.png' });
    assert.notEqual(up2.body.photo_url, up.body.photo_url);
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(!fs.existsSync(file1), 'old photo file removed');

    const removed = await a.del(`/api/meals/recipes/${r.id}/photo`);
    assert.equal(removed.body.photo_url, null);
  });

  test('recipes are isolated between families', async () => {
    const r = (await fx.admin.agent.post('/api/meals/recipes', recipeBody({ title: 'Secret sauce' }))).body;
    const b = other.admin.agent;
    assert.equal((await b.get(`/api/meals/recipes/${r.id}`)).status, 404);
    assert.equal((await b.patch(`/api/meals/recipes/${r.id}`, { title: 'Hacked' })).status, 404);
    assert.equal((await b.del(`/api/meals/recipes/${r.id}`)).status, 404);
    assert.equal((await b.put(`/api/meals/recipes/${r.id}/favorite`, { favorite: true })).status, 404);
    assert.equal((await b.upload(`/api/meals/recipes/${r.id}/photo`, { file: PNG_1X1 })).status, 404);
    assert.ok(!(await b.get('/api/meals/recipes')).body.some((x) => x.id === r.id));
    assert.equal((await b.post('/api/meals/plan', { date: '2026-10-01', slot: 'dinner', recipe_id: r.id })).status, 404);
    assert.equal((await fx.admin.agent.get(`/api/meals/recipes/${r.id}`)).body.title, 'Secret sauce');
  });

  test('children can add recipes but only edit their own', async () => {
    const kid = await addChild(fx);
    const mine = await kid.agent.post('/api/meals/recipes', recipeBody({ title: 'Kid cookies' }));
    assert.equal(mine.status, 201);
    assert.equal((await kid.agent.patch(`/api/meals/recipes/${mine.body.id}`, { title: 'Best cookies' })).status, 200);
    const grown = (await fx.admin.agent.post('/api/meals/recipes', recipeBody({ title: 'Grown-up dish' }))).body;
    assert.equal((await kid.agent.patch(`/api/meals/recipes/${grown.id}`, { title: 'Nope' })).status, 403);
    assert.equal((await kid.agent.del(`/api/meals/recipes/${grown.id}`)).status, 403);
    assert.equal((await kid.agent.put(`/api/meals/recipes/${grown.id}/favorite`, { favorite: true })).status, 200, 'kids can favorite anything');
    assert.equal((await fx.member.agent.patch(`/api/meals/recipes/${mine.body.id}`, { title: 'Edited by parent' })).status, 200);
    assert.equal((await kid.agent.del(`/api/meals/recipes/${mine.body.id}`)).status, 200);
  });
});

describe('meal plan', () => {
  let fx;
  let other;
  let pasta;
  let salad;
  const week = '2026-10-05'; // a Monday
  before(async () => {
    fx = await familyFixture(srv, 'Plan A');
    other = await familyFixture(srv, 'Plan B');
    pasta = (await fx.admin.agent.post('/api/meals/recipes', recipeBody({
      title: 'Pasta', servings: 4, ingredients: ['400 g pasta', '2 tomatoes', '1 cup parmesan', 'salt'],
    }))).body;
    salad = (await fx.admin.agent.post('/api/meals/recipes', recipeBody({
      title: 'Salad', servings: 2, ingredients: ['1 tomato', '100 g feta'],
    }))).body;
  });

  test('plan CRUD with recipe and free-text meals', async () => {
    const a = fx.admin.agent;
    const e1 = await a.post('/api/meals/plan', { date: week, slot: 'dinner', recipe_id: pasta.id, note: 'Double batch' });
    assert.equal(e1.status, 201, JSON.stringify(e1.body));
    assert.equal(e1.body.title, 'Pasta');
    assert.equal(e1.body.recipe.id, pasta.id);
    const e2 = await a.post('/api/meals/plan', { date: addDays(week, 1), slot: 'lunch', title: 'Leftovers' });
    assert.equal(e2.status, 201);
    assert.equal(e2.body.recipe, null);
    const out = await a.post('/api/meals/plan', { date: addDays(week, 7), slot: 'dinner', title: 'Next week' });
    assert.equal(out.status, 201);

    const plan = await fx.member.agent.get(`/api/meals/plan?start=${week}`);
    assert.equal(plan.status, 200);
    assert.equal(plan.body.start, week);
    assert.equal(plan.body.end, addDays(week, 6));
    assert.deepEqual(plan.body.entries.map((e) => e.title), ['Pasta', 'Leftovers']);

    const moved = await a.patch(`/api/meals/plan/${e1.body.id}`, { date: addDays(week, 2), slot: 'lunch' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.date, addDays(week, 2));
    assert.equal(moved.body.note, 'Double batch');
    const swapped = await a.patch(`/api/meals/plan/${e2.body.id}`, { recipe_id: salad.id });
    assert.equal(swapped.body.title, 'Salad');
    const freeText = await a.patch(`/api/meals/plan/${e2.body.id}`, { recipe_id: null, title: 'Pizza out' });
    assert.equal(freeText.body.title, 'Pizza out');
    assert.equal(freeText.body.recipe, null);

    // renaming a recipe renames its planned meals; deleting it keeps them as free text
    await a.patch(`/api/meals/recipes/${salad.id}`, { title: 'Salad' });
    assert.equal((await a.del(`/api/meals/plan/${e2.body.id}`)).status, 200);
    assert.equal((await a.del(`/api/meals/plan/${e2.body.id}`)).status, 404);
    assert.ok(!(await a.get(`/api/meals/plan?start=${week}`)).body.entries.some((e) => e.id === e2.body.id), 'removed meals are hidden');
    assert.equal((await other.admin.agent.post(`/api/meals/plan/${e2.body.id}/restore`)).status, 404, 'other families cannot restore');
    const activityBefore = (await a.get('/api/activity?module=meals&limit=100')).body.length;
    const restored = await a.post(`/api/meals/plan/${e2.body.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.id, e2.body.id, 'undo brings back the same row');
    assert.equal(restored.body.title, 'Pizza out');
    assert.equal((await a.get('/api/activity?module=meals&limit=100')).body.length, activityBefore, 'restore is silent');
    assert.equal((await a.post(`/api/meals/plan/${e2.body.id}/restore`)).status, 404, 'nothing left to restore');
    await a.del(`/api/meals/plan/${e2.body.id}`);
    // restoring into a slot that filled up meanwhile is refused instead of overfilling it
    const full = '2027-05-03';
    const gone = (await a.post('/api/meals/plan', { date: full, slot: 'snack', title: 'Gone' })).body;
    await a.del(`/api/meals/plan/${gone.id}`);
    for (let i = 0; i < 6; i++) await a.post('/api/meals/plan', { date: full, slot: 'snack', title: `Snack ${i}` });
    assert.match((await a.post(`/api/meals/plan/${gone.id}/restore`)).body.error, /already has 6/);
    const cleared = (await a.del(`/api/meals/plan?start=${full}&days=1`)).body;
    for (let i = 0; i < 2; i++) await a.post('/api/meals/plan', { date: full, slot: 'snack', title: `New ${i}` });
    const undone = (await a.post('/api/meals/plan/restore', { batch: cleared.batch })).body;
    assert.deepEqual([undone.restored, undone.skipped], [4, 2], 'batch undo never overfills a slot');
    assert.equal((await a.get(`/api/meals/plan?start=${full}&days=1`)).body.entries.length, 6);
  });

  test('plan validation', async () => {
    const a = fx.admin.agent;
    assert.match((await a.post('/api/meals/plan', { date: '2026-02-31', slot: 'dinner', title: 'x' })).body.error, /valid date/);
    assert.match((await a.post('/api/meals/plan', { date: week, slot: 'brunch', title: 'x' })).body.error, /breakfast, lunch/);
    assert.match((await a.post('/api/meals/plan', { date: week, slot: 'dinner' })).body.error, /Pick a recipe/);
    assert.equal((await a.post('/api/meals/plan', { date: week, slot: 'dinner', recipe_id: 999999 })).status, 404);
    assert.match((await a.post('/api/meals/plan', { date: week, slot: 'dinner', title: 'x', cook_id: other.admin.user.id })).body.error, /member of this family/);
    assert.match((await a.post('/api/meals/plan', { date: week, slot: 'dinner', title: 'x', servings: 0 })).body.error, /Servings/);
    assert.equal((await a.get('/api/meals/plan?start=nope')).status, 400);
    assert.equal((await a.get('/api/meals/plan?start=2026-10-05&days=100')).status, 400);
    for (let i = 0; i < 6; i++) await a.post('/api/meals/plan', { date: '2027-01-04', slot: 'snack', title: `Snack ${i}` });
    assert.match((await a.post('/api/meals/plan', { date: '2027-01-04', slot: 'snack', title: 'One too many' })).body.error, /already has 6/);
  });

  test('plan entries are family-scoped', async () => {
    const e = (await fx.admin.agent.post('/api/meals/plan', { date: week, slot: 'breakfast', title: 'Toast' })).body;
    const b = other.admin.agent;
    assert.equal((await b.patch(`/api/meals/plan/${e.id}`, { title: 'x' })).status, 404);
    assert.equal((await b.del(`/api/meals/plan/${e.id}`)).status, 404);
    assert.equal((await b.get(`/api/meals/plan?start=${week}`)).body.entries.length, 0);
    assert.equal((await b.get(`/api/meals/plan/ingredients?start=${week}`)).body.items.length, 0);
    assert.equal((await fx.admin.agent.patch(`/api/meals/plan/${e.id}`, { recipe_id: (await b.post('/api/meals/recipes', recipeBody())).body.id })).status, 404);
    await fx.admin.agent.del(`/api/meals/plan/${e.id}`);
  });

  test('assigning a cook notifies them (not yourself)', async () => {
    const before = (await fx.member.agent.get('/api/notifications')).body.unread;
    const e = (await fx.admin.agent.post('/api/meals/plan', { date: week, slot: 'dinner', recipe_id: salad.id, cook_id: fx.member.user.id })).body;
    const after = (await fx.member.agent.get('/api/notifications')).body;
    assert.equal(after.unread, before + 1);
    assert.match(after.items[0].title, /You're cooking Salad/);
    assert.equal(after.items[0].link, `/meals?week=${week}`);
    const adminBefore = (await fx.admin.agent.get('/api/notifications')).body.unread;
    await fx.admin.agent.patch(`/api/meals/plan/${e.id}`, { cook_id: fx.admin.user.id });
    assert.equal((await fx.admin.agent.get('/api/notifications')).body.unread, adminBefore, 'no self-notification');
    await fx.admin.agent.patch(`/api/meals/plan/${e.id}`, { note: 'no cook change' });
    assert.equal((await fx.member.agent.get('/api/notifications')).body.unread, before + 1);
    await fx.admin.agent.del(`/api/meals/plan/${e.id}`);
  });

  test('shopping ingredients aggregate the week and scale by servings', async () => {
    const wk = '2026-11-02';
    const a = fx.admin.agent;
    await a.post('/api/meals/plan', { date: wk, slot: 'dinner', recipe_id: pasta.id });
    await a.post('/api/meals/plan', { date: addDays(wk, 1), slot: 'dinner', recipe_id: pasta.id, servings: 8 });
    await a.post('/api/meals/plan', { date: addDays(wk, 2), slot: 'lunch', recipe_id: salad.id });
    await a.post('/api/meals/plan', { date: addDays(wk, 3), slot: 'lunch', title: 'Eating out' });
    const res = await a.get(`/api/meals/plan/ingredients?start=${wk}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.meal_count, 3);
    assert.deepEqual(res.body.free_text.map((f) => f.title), ['Eating out']);
    const texts = res.body.items.map((i) => i.text);
    assert.ok(texts.includes('1.2 kg pasta'), texts.join(' | ')); // 400 + 800
    assert.ok(texts.includes('7 tomatoes'), texts.join(' | ')); // 2 + 4 + 1
    assert.ok(texts.includes('3 cups parmesan'), texts.join(' | '));
    assert.ok(texts.includes('100 g feta'), texts.join(' | '));
    assert.ok(texts.includes('salt'));
    const tomato = res.body.items.find((i) => i.text === '7 tomatoes');
    assert.deepEqual(tomato.recipes.sort(), ['Pasta', 'Salad']);
    assert.equal(tomato.category, 'Produce');
  });

  test('copy a week (merge skips duplicates, replace overwrites) and clear it', async () => {
    const from = '2026-12-07';
    const to = '2026-12-14';
    const a = fx.admin.agent;
    await a.post('/api/meals/plan', { date: from, slot: 'dinner', recipe_id: pasta.id, cook_id: fx.member.user.id });
    await a.post('/api/meals/plan', { date: addDays(from, 3), slot: 'breakfast', title: 'Oats' });
    await a.post('/api/meals/plan', { date: addDays(to, 1), slot: 'lunch', title: 'Existing' });

    const c1 = await a.post('/api/meals/plan/copy', { from, to });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.body.copied, 2);
    assert.deepEqual(c1.body.entries.map((e) => [e.date, e.title]), [[to, 'Pasta'], [addDays(to, 1), 'Existing'], [addDays(to, 3), 'Oats']]);
    assert.equal(c1.body.entries[0].cook_id, fx.member.user.id);
    const c2 = await a.post('/api/meals/plan/copy', { from, to });
    assert.equal(c2.body.copied, 0);
    assert.equal(c2.body.skipped, 2);
    const c3 = await a.post('/api/meals/plan/copy', { from, to, replace: true });
    assert.equal(c3.body.entries.length, 2, 'replace removes "Existing"');
    assert.equal(c3.body.replaced, 3);
    // undo the replace: back to Pasta + Existing + Oats from the first copy
    const undo = await a.post('/api/meals/plan/restore', { batch: c3.body.batch });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.deepEqual((await a.get(`/api/meals/plan?start=${to}`)).body.entries.map((e) => e.title), ['Pasta', 'Existing', 'Oats']);
    assert.equal((await a.post('/api/meals/plan/restore', { batch: c3.body.batch })).status, 404);
    await a.post('/api/meals/plan/copy', { from, to, replace: true });
    assert.match((await a.post('/api/meals/plan/copy', { from: addDays(from, 1), to: addDays(to, 1) })).body.error, /Monday/);
    assert.match((await a.post('/api/meals/plan/copy', { from, to: addDays(from, 7), days: 14 })).body.error, /overlap/);
    assert.match((await a.post('/api/meals/plan/copy', { from: '2030-01-07', to })).body.error, /no meals/);
    assert.equal((await a.post('/api/meals/plan/copy', { from, to: from })).status, 400);

    const kid = await addChild(fx, 'Copy kid');
    assert.equal((await kid.agent.post('/api/meals/plan/copy', { from, to })).status, 403);
    assert.equal((await kid.agent.del(`/api/meals/plan?start=${to}`)).status, 403);

    // other family's clear doesn't touch ours
    await other.admin.agent.del(`/api/meals/plan?start=${to}`);
    assert.equal((await a.get(`/api/meals/plan?start=${to}`)).body.entries.length, 2);
    assert.equal((await a.del('/api/meals/plan')).status, 400);
    const cleared = await a.del(`/api/meals/plan?start=${to}`);
    assert.equal(cleared.body.deleted, 2);
    assert.equal((await a.get(`/api/meals/plan?start=${to}`)).body.entries.length, 0);
    assert.equal((await kid.agent.post('/api/meals/plan/restore', { batch: cleared.body.batch })).status, 403);
    assert.equal((await other.admin.agent.post('/api/meals/plan/restore', { batch: cleared.body.batch })).status, 404);
    assert.equal((await a.post('/api/meals/plan/restore', { batch: cleared.body.batch })).body.restored, 2, 'undo clear');
    assert.equal((await a.get(`/api/meals/plan?start=${to}`)).body.entries.length, 2);
    await a.del(`/api/meals/plan?start=${to}`);
    assert.equal((await a.get(`/api/meals/plan?start=${from}`)).body.entries.length, 2, 'source week untouched');
  });

  test('children can plan meals but only change their own', async () => {
    const kid = await addChild(fx, 'Planner kid');
    const mine = await kid.agent.post('/api/meals/plan', { date: '2027-02-01', slot: 'snack', title: 'Popcorn' });
    assert.equal(mine.status, 201);
    assert.equal((await kid.agent.patch(`/api/meals/plan/${mine.body.id}`, { title: 'Apple slices' })).status, 200);
    const grown = (await fx.admin.agent.post('/api/meals/plan', { date: '2027-02-01', slot: 'dinner', title: 'Soup' })).body;
    assert.equal((await kid.agent.patch(`/api/meals/plan/${grown.id}`, { title: 'Candy' })).status, 403);
    assert.equal((await kid.agent.del(`/api/meals/plan/${grown.id}`)).status, 403);
    assert.equal((await kid.agent.del(`/api/meals/plan/${mine.body.id}`)).status, 200);
  });

  test('dashboard returns today\'s meals in slot order (in the viewer\'s time zone)', async () => {
    const tz = 'Pacific/Kiritimati'; // UTC+14: usually a different day than the server's
    const today = dateIn(tz);
    const a = fx.admin.agent;
    await a.post('/api/meals/plan', { date: today, slot: 'dinner', recipe_id: pasta.id });
    await a.post('/api/meals/plan', { date: today, slot: 'breakfast', title: 'Cereal' });
    const dash = await fx.member.agent.get('/api/dashboard', { headers: { 'x-timezone': tz } });
    assert.equal(dash.status, 200);
    const meals = dash.body.meals;
    assert.deepEqual(meals.today.map((m) => [m.slot, m.title, m.recipe_id]), [['breakfast', 'Cereal', undefined], ['dinner', 'Pasta', pasta.id]]);
    assert.equal((await other.admin.agent.get('/api/dashboard', { headers: { 'x-timezone': tz } })).body.meals.today.length, 0);
    const overview = await fx.member.agent.get('/api/meals', { headers: { 'x-timezone': tz } });
    assert.equal(overview.body.today.length, 2);
  });

  test('mutations broadcast meals.* events and log activity', async () => {
    const listener = fx.member.agent;
    const { events } = await collectEvents(listener, { until: (e) => e.type === 'meals.plan.deleted', timeoutMs: 4000 });
    const a = fx.admin.agent;
    const r = (await a.post('/api/meals/recipes', recipeBody({ title: 'Live dish' }))).body;
    await a.patch(`/api/meals/recipes/${r.id}`, { servings: 2 });
    await a.put(`/api/meals/recipes/${r.id}/favorite`, { favorite: true });
    const e = (await a.post('/api/meals/plan', { date: '2027-03-01', slot: 'dinner', recipe_id: r.id })).body;
    await a.patch(`/api/meals/plan/${e.id}`, { slot: 'lunch' });
    await a.del(`/api/meals/recipes/${r.id}`);
    await a.del(`/api/meals/plan/${e.id}`);
    const types = (await events).map((x) => x.type).filter((t) => t.startsWith('meals.'));
    assert.deepEqual(types, [
      'meals.recipe.created', 'meals.recipe.updated', 'meals.favorite.updated', 'meals.plan.created',
      'meals.plan.updated', 'meals.recipe.deleted', 'meals.plan.deleted',
    ]);
    const other = await collectEvents(listener, { until: (x) => x.type === 'meals.plan.copied', timeoutMs: 4000 });
    await a.post('/api/meals/plan', { date: '2027-03-08', slot: 'dinner', title: 'Tacos' });
    await a.post('/api/meals/plan/copy', { from: '2027-03-08', to: '2027-03-15' });
    assert.ok((await other.events).some((x) => x.type === 'meals.plan.copied' && x.payload.copied === 1));

    const feed = (await a.get('/api/activity?module=meals&limit=50')).body;
    const summaries = feed.map((x) => x.summary);
    assert.ok(summaries.includes('added the recipe Live dish'));
    assert.ok(summaries.some((s) => /^planned Live dish for Monday dinner$/.test(s)), summaries.join('|'));
    assert.ok(summaries.some((s) => /^copied 1 meal into the week of Mar 15$/.test(s)), summaries.join('|'));
    assert.ok(feed.every((x) => x.link?.startsWith('/meals')));
  });
});

test('seed creates recipes with photos, favorites and this week\'s plan', async () => {
  const { familyId, users } = await seedDemo(srv.ctx, srv.app.locals.modules, { log: () => {} });
  const alex = srv.agent();
  await alex.post('/api/auth/login', { email: 'alex@hearth.test', password: DEMO_PASSWORD });
  alex.familyId = familyId;
  const recipes = (await alex.get('/api/meals/recipes')).body;
  assert.ok(recipes.length >= 8);
  assert.ok(recipes.filter((r) => r.photo_url).length >= 6);
  assert.ok(recipes.every((r) => r.ingredient_count > 0 && r.step_count > 0));
  assert.ok(recipes.some((r) => r.favorite), 'alex has favorites');
  const photo = await alex.get(recipes.find((r) => r.photo_url).photo_url);
  assert.equal(photo.status, 200);
  assert.match(photo.headers.get('content-type'), /svg/);

  const monday = mondayOf(localDateKey());
  const plan = (await alex.get(`/api/meals/plan?start=${monday}`)).body;
  assert.ok(plan.entries.length >= 12);
  assert.equal(new Set(plan.entries.filter((e) => e.slot === 'dinner').map((e) => e.date)).size, 7, 'a dinner every day');
  assert.ok(plan.entries.some((e) => e.cook_id === users.mia.id));
  const lastWeek = (await alex.get(`/api/meals/plan?start=${addDays(monday, -7)}`)).body;
  assert.ok(lastWeek.entries.length >= 8);
  const dash = (await alex.get('/api/dashboard')).body.meals;
  assert.ok(dash.today.length >= 1);
  const shop = (await alex.get(`/api/meals/plan/ingredients?start=${monday}`)).body;
  assert.ok(shop.items.length > 20);

  // re-seeding recreates the family cleanly
  const again = await seedDemo(srv.ctx, srv.app.locals.modules, { log: () => {} });
  const demoFamilies = srv.db.prepare("SELECT id FROM families WHERE invite_code = 'HRTH-2026'").all().map((f) => f.id);
  assert.deepEqual(demoFamilies, [again.familyId]);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM meal_plan WHERE family_id = ?').get(again.familyId).n, plan.entries.length + lastWeek.entries.length);
  void familyId;
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM meal_recipes WHERE family_id = ?').get(again.familyId).n, recipes.length);
});
