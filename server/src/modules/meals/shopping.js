// Ingredient aggregation for "Add the week's ingredients to a shopping list" (no db, easy to test).
// Parsing/wording lives in /shared/meals/ingredients.js so the web client uses the exact same code.
import {
  fmtQty, ingredientText, nameForCount, nameKey, normalizeUnit, parseAmount, parseIngredientLine, pluralWord, roundQty,
  singularWord, splitCountNoun, unitLabel, amountText,
} from '../../../../shared/meals/ingredients.js';

export {
  fmtQty, ingredientText, nameForCount, nameKey, normalizeUnit, parseAmount, parseIngredientLine, pluralWord, roundQty,
  singularWord, splitCountNoun, unitLabel, amountText,
};

// Shopping aisles are the Lists module's canonical ones (/shared/lists/aisles.json), so pushing the
// week's ingredients into a list never creates look-alike sections ("Dairy" vs "Dairy & Eggs").
import fs from 'node:fs';
import { createClassifier } from '../../../../shared/lists/classify.js';

const AISLE_DATA = JSON.parse(fs.readFileSync(new URL('../../../../shared/lists/aisles.json', import.meta.url), 'utf8'));
const listsClassifier = createClassifier(AISLE_DATA);
/** Lists' aisle order (Produce, Bakery, Dairy, Meat, Pantry, Frozen, Drinks, …, Other). */
export const AISLES = AISLE_DATA.categories;
const TO_AISLE = { Produce: 'Produce', 'Meat & Fish': 'Meat', 'Dairy & Eggs': 'Dairy', Bakery: 'Bakery', Pantry: 'Pantry', Spices: 'Pantry', Frozen: 'Frozen' };
/** Canonical Lists aisle for an ingredient: our (recipe-aware) guess mapped over, else Lists' own classifier. */
export function aisleFor(name, unit) {
  const mine = guessCategory(name, unit);
  const aisle = TO_AISLE[mine] ?? listsClassifier.guessCategory(String(name));
  return AISLES.includes(aisle) ? aisle : 'Other';
}
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Base units for summing compatible quantities.
const TO_BASE = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], oz: ['oz', 1], lb: ['oz', 16] };

// ------------------------------------------------------------------ categories

/** Specific phrases win over single words ("coconut milk" is pantry, "egg noodles" isn't dairy). */
const PHRASES = [
  [/\b(garlic|ginger) (cloves?|bulbs?|heads?)\b|\b(cloves?|bulbs?|heads?) (of )?garlic\b/, 'Produce'],
  [/\b(ground|whole) cloves?\b/, 'Spices'],
  [/\b(egg|rice|udon|soba|ramen|glass) noodles?\b|\bnoodles?\b/, 'Pantry'],
  [/\bcoconut (milk|cream)\b/, 'Pantry'],
  [/\b(canned|tinned|crushed|chopped|diced|stewed|sun-?dried|peeled) tomato(es)?\b|\btomato (paste|sauce|puree|purée)\b|\bpassata\b/, 'Pantry'],
  [/\bflour\b/, 'Pantry'],
  [/\b(black|white|ground|cayenne) pepper\b|\bpeppercorns?\b|\bsalt and (black )?pepper\b/, 'Spices'],
  [/\b(bell|red|green|yellow|orange|sweet|jalape[nñ]o) peppers?\b(?! flakes)/, 'Produce'],
  [/\b(stock|broth|bouillon)\b/, 'Pantry'],
  [/\bsour cream\b|\bcream cheese\b|\bcr[eè]me fra[iî]che\b/, 'Dairy & Eggs'],
  [/\b(peanut|almond|cashew) butter\b/, 'Pantry'],
  [/\bice cream\b|\bfrozen\b/, 'Frozen'],
  [/\bbaking (powder|soda)\b|\bbicarbonate\b|\bvanilla (extract|essence)\b|\byeast\b|\bcornstarch\b|\bcorn ?flour\b/, 'Pantry'],
  [/\b(soy|fish|hot|bbq|barbecue|worcestershire|oyster|hoisin) sauce\b/, 'Pantry'],
  [/\b(maple|golden|agave) syrup\b/, 'Pantry'],
  [/\bcurry paste\b/, 'Pantry'],
  [/\b(olive|sesame|vegetable|canola|sunflower|coconut|rapeseed) oil\b/, 'Pantry'],
  [/\b(sesame|chia|pumpkin|sunflower|poppy|flax) seeds?\b/, 'Pantry'],
  [/\b(spring|green) onions?\b|\bscallions?\b/, 'Produce'],
  [/\bchocolate chips?\b|\bcocoa\b/, 'Pantry'],
  [/\b(rolled|porridge|steel-cut) oats\b|\boats\b/, 'Pantry'],
  [/\bolives?\b/, 'Pantry'],
  [/^pepper$|\bpepper to taste\b|\b(red )?pepper flakes\b|\bsmoked paprika\b|\bchil+i (powder|flakes)\b|\bchil+i\b(?= flakes)|\bcurry powder\b|\bgaram masala\b|\bdried (oregano|thyme|basil|herbs|parsley|rosemary)\b|\bbay lea(f|ves)\b/, 'Spices'],
  [/\bbread ?crumbs\b|\bpanko\b/, 'Pantry'],
  [/\benglish muffins?\b|\bmuffins?\b|\bcrumpets?\b|\bpitta\b/, 'Bakery'],
  [/\btofu\b|\btempeh\b/, 'Dairy & Eggs'],
  [/\b(brown|caster|icing|powdered|granulated) sugar\b/, 'Pantry'],
  [/\b(greek )?yog(h)?urt\b/, 'Dairy & Eggs'],
  [/\b(kidney|black|pinto|cannellini|butter|baked|green) beans\b/, 'Pantry'],
  [/\bfresh (herbs|basil|parsley|dill|mint|cilantro|coriander|thyme|rosemary)\b/, 'Produce'],
];
const HEADS = {
  Produce: 'apple banana berry blueberry strawberry raspberry blackberry cranberry cherry lemon lime orange onion shallot garlic ginger tomato potato carrot celery chili chilli cucumber lettuce romaine spinach kale avocado zucchini courgette broccoli cauliflower mushroom basil parsley cilantro coriander mint thyme rosemary dill leek cabbage corn pea squash pumpkin grape mango pineapple peach pear melon asparagus eggplant aubergine radish beet beetroot arugula rocket chive herb fruit sprout pepper plum kiwi fennel jalapeño jalapeno serrano habanero',
  'Meat & Fish': 'chicken thigh breast beef pork lamb turkey bacon sausage ham mince steak salmon fillet tuna cod fish shrimp prawn chorizo prosciutto meatball drumstick',
  'Dairy & Eggs': 'milk cream butter cheese parmesan mozzarella cheddar feta ricotta halloumi yogurt yoghurt egg mascarpone buttermilk',
  Bakery: 'bread bun roll tortilla pita bagel baguette brioche naan wrap croissant',
  Pantry: 'rice pasta spaghetti penne macaroni fusilli lasagna lentil chickpea bean sugar vinegar ketchup mustard mayonnaise mayo jam quinoa couscous nut almond peanut walnut cashew pecan cereal chocolate syrup sauce raisin honey tahini',
  Spices: 'salt paprika cumin cinnamon oregano turmeric nutmeg spice seasoning vanilla clove cardamom',
};
const HEAD_LOOKUP = new Map();
for (const [cat, words] of Object.entries(HEADS)) for (const w of words.split(' ')) HEAD_LOOKUP.set(w, cat);

export function guessCategory(name, unit) {
  // Anything bought in a can, tin or jar lives in the pantry aisle.
  if (['can', 'jar'].includes(normalizeUnit(unit)) || /\b(canned|tinned)\b/i.test(String(name))) return 'Pantry';
  const n = String(name || '').toLowerCase().replace(/[^\p{L}\p{N} -]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, cat] of PHRASES) if (re.test(n)) return cat;
  // Head noun: the last word that we know, scanning right to left ("chicken thighs" -> thigh).
  const words = n.split(' ').map((w) => singularWord(w).toLowerCase());
  for (let i = words.length - 1; i >= 0; i--) {
    const cat = HEAD_LOOKUP.get(words[i]);
    if (cat) return cat;
  }
  return 'Other';
}

// Liquids whose volumes can be summed across units (cups + ml + tbsp …).
const LIQUID = /\b(milk|buttermilk|oil|stock|broth|cream|wine|juice|vinegar|syrup|honey|sauce|beer|cider|kefir)\b/;
const NOT_LIQUID = /\b(sour cream|cream cheese|ice cream|milk chocolate|powdered milk|milk powder)\b/;
const ML_PER = { tsp: 4.929, tbsp: 14.787, cup: 236.59, 'fl oz': 29.574, ml: 1, l: 1000 };
const isLiquid = (k) => LIQUID.test(k) && !NOT_LIQUID.test(k);

/** A summed volume in the most natural unit: metric when any input was metric, US otherwise. */
function volumeOut(ml, metric) {
  if (metric) {
    if (ml >= 1000) return { quantity: Math.round(ml / 10) / 100, unit: 'l' };
    return { quantity: ml >= 100 ? Math.round(ml / 5) * 5 : Math.round(ml), unit: 'ml' };
  }
  return spoonsOut(ml);
}

/** US volume (in ml) as cups (≥ ¼ cup, to the nearest ⅛ or ⅓), else tablespoons, else teaspoons. */
function spoonsOut(ml) {
  if (ml >= ML_PER.cup / 4 - 1) return { quantity: nearestCup(ml / ML_PER.cup), unit: 'cup' };
  if (ml >= ML_PER.tbsp - 0.3) return { quantity: Math.round((ml / ML_PER.tbsp) * 2) / 2, unit: 'tbsp' };
  return { quantity: Math.round((ml / ML_PER.tsp) * 4) / 4, unit: 'tsp' };
}
function nearestCup(cups) {
  const whole = Math.floor(cups);
  const frac = cups - whole;
  const steps = [0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1];
  const best = steps.reduce((a, b) => (Math.abs(b - frac) < Math.abs(a - frac) ? b : a));
  return Math.round((whole + best) * 1000) / 1000;
}
const US_VOLUME = new Set(['tsp', 'tbsp', 'cup']);

/** Things nobody puts on a shopping list. */
export const isPantryFreebie = (name) => /^(warm|cold|hot|boiling|iced?|tap|lukewarm|cool)?\s*water$/i.test(String(name || '').trim());

// Grams per volume unit for common ingredients, so "80 g butter" + "3 tbsp butter" become one line.
const DENSITY = {
  butter: { tbsp: 14, tsp: 4.7, cup: 227 },
  flour: { cup: 125, tbsp: 8 },
  sugar: { cup: 200, tbsp: 12.5, tsp: 4.2 },
  'brown sugar': { cup: 220, tbsp: 13.8 },
};

/**
 * Aggregate ingredient rows across planned meals.
 *   rows: [{ name, quantity, unit, factor, recipe_title }]
 * Returns [{ key, name, quantity, unit, text, category, recipes:[title] }], sorted by category then name,
 * with lines of the same ingredient in different units next to each other.
 */
export function aggregateIngredients(rows) {
  const prepared = rows
    .filter((r) => r.name && !isPantryFreebie(r.name))
    .flatMap((r) => {
      // "Salt and black pepper" is two things on a shopping list.
      const sp = String(r.name).trim().match(/^salt\s*(?:and|&)\s*((?:freshly )?(?:ground )?(?:black |white )?pepper)$/i);
      return sp ? [{ ...r, name: 'salt' }, { ...r, name: sp[1].replace(/^freshly /i, '') }] : [r];
    })
    .map((raw) => {
      const r = splitCountNoun({ ...raw, unit: raw.unit ? normalizeUnit(raw.unit) : null, name: String(raw.name).trim() });
      const hasQty = r.quantity != null && Number.isFinite(Number(r.quantity));
      const row = { ...r, k: nameKey(r.name), unit: r.unit ?? '', qty: hasQty ? Number(r.quantity) * (r.factor ?? 1) : null };
      // "1 dozen eggs" is just 12 eggs, so it adds up with "2 eggs".
      if (row.unit === 'dozen' && row.qty != null) {
        row.qty *= 12;
        row.unit = '';
      }
      return row;
    });
  // Liquids measured in more than one volume unit are summed in ml and shown in one natural unit.
  const volUnits = new Map();
  for (const r of prepared) if (r.qty != null && ML_PER[r.unit]) volUnits.set(r.k, new Set([...(volUnits.get(r.k) ?? []), r.unit]));
  // Liquids merge across any volume units; anything else only across US spoons/cups (volume is volume).
  for (const [k, units] of volUnits) if (!isLiquid(k) && ![...units].every((u) => US_VOLUME.has(u))) volUnits.delete(k);
  const liquidMetric = new Map();
  for (const r of prepared) {
    const units = volUnits.get(r.k);
    if (r.qty != null && units && units.size > 1 && ML_PER[r.unit]) {
      if (r.unit === 'ml' || r.unit === 'l') liquidMetric.set(r.k, true);
      else if (!liquidMetric.has(r.k)) liquidMetric.set(r.k, false);
      r.qty *= ML_PER[r.unit];
      r.unit = 'vol';
    }
  }
  // Names that appear with a weight somewhere: convert their volume amounts to grams when we know how.
  const weighed = new Set(prepared.filter((r) => r.qty != null && ['g', 'kg'].includes(r.unit)).map((r) => r.k));
  for (const r of prepared) {
    if (r.qty != null && weighed.has(r.k) && (r.unit === 'oz' || r.unit === 'lb')) {
      r.qty *= r.unit === 'lb' ? 453.6 : 28.35;
      r.unit = 'g';
    }
  }
  for (const r of prepared) {
    const d = DENSITY[r.k];
    if (r.qty != null && weighed.has(r.k) && d && d[r.unit]) {
      r.qty *= d[r.unit];
      r.unit = 'g';
    }
  }

  const groups = new Map();
  for (const r of prepared) {
    let qty = r.qty;
    let baseUnit = r.unit;
    if (qty != null && TO_BASE[r.unit]) {
      const [b, mult] = TO_BASE[r.unit];
      baseUnit = b;
      qty *= mult;
    }
    const key = `${r.k}|${qty != null ? baseUnit : '-'}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, k: r.k, name: String(r.name).trim(), quantity: qty != null ? 0 : null, unit: baseUnit, recipes: [] };
      groups.set(key, g);
    }
    if (qty != null) g.quantity += qty;
    if (r.recipe_title && !g.recipes.includes(r.recipe_title)) g.recipes.push(r.recipe_title);
  }
  // A name that appears both with and without a quantity: fold the bare line into the quantified one.
  const out = [];
  const all = [...groups.values()];
  for (const g of all) {
    if (g.quantity == null) {
      const quantified = all.filter((o) => o !== g && o.k === g.k && o.quantity != null);
      if (quantified.length) {
        for (const t of g.recipes) if (!quantified[0].recipes.includes(t)) quantified[0].recipes.push(t);
        continue;
      }
    }
    let { quantity, unit } = g;
    if (quantity != null && unit === 'vol') ({ quantity, unit } = volumeOut(quantity, liquidMetric.get(g.k) === true));
    else if (quantity != null) {
      if (unit === 'g' && quantity >= 1000) { quantity /= 1000; unit = 'kg'; }
      else if (unit === 'ml' && quantity >= 1000) { quantity /= 1000; unit = 'l'; }
      else if (unit === 'oz' && quantity >= 16) { quantity /= 16; unit = 'lb'; }
      // Big spoon totals read better in cups: 12 tsp -> ¼ cup, 11 tbsp -> ⅔ cup.
      if (unit === 'tsp' && quantity >= 3) ({ quantity, unit } = spoonsOut(quantity * ML_PER.tsp));
      else if (unit === 'tbsp' && quantity >= 4) ({ quantity, unit } = spoonsOut(quantity * ML_PER.tbsp));
      quantity = roundQty(quantity);
    }
    out.push({
      key: g.key,
      k: g.k,
      name: g.name,
      quantity,
      unit: unit || null,
      text: ingredientText({ quantity, unit, name: g.name }),
      // For the Lists push: { text: label, quantity: amount } renders as "Butter" with a "164 g" chip.
      label: capitalize(nameForCount(g.name, quantity, unit)),
      amount: quantity != null ? amountText(quantity, unit) : null,
      category: aisleFor(g.name, unit),
      recipes: g.recipes,
    });
  }
  // One category per ingredient, so all its lines stay together.
  // Canned/jarred lines stay in the pantry even when the fresh version is produce.
  const canned = (o) => o.unit === 'can' || o.unit === 'jar';
  const catOf = new Map();
  for (const o of out) if (!canned(o) && !catOf.has(o.k)) catOf.set(o.k, o.category);
  for (const o of out) if (!canned(o)) o.category = catOf.get(o.k);
  out.sort((a, b) => AISLES.indexOf(a.category) - AISLES.indexOf(b.category) || a.k.localeCompare(b.k) || (a.unit ?? '').localeCompare(b.unit ?? ''));
  return out.map(({ k, ...rest }) => rest);
}
