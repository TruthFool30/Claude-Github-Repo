// Ingredient text helpers shared by the server (server/src/modules/meals/shopping.js) and the web
// client (client/src/modules/meals/utils.ts) so parsing and wording can never drift apart.
// Plain ESM JavaScript with no dependencies; types live in ingredients.d.ts.

// ------------------------------------------------------------------ units

const UNIT_ALIASES = {
  tsp: ['tsp', 'teaspoon', 'teaspoons', 't'],
  tbsp: ['tbsp', 'tablespoon', 'tablespoons', 'tbs', 'tbl'],
  cup: ['cup', 'cups', 'c'],
  g: ['g', 'gram', 'grams', 'gr'],
  kg: ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  clove: ['clove', 'cloves'],
  can: ['can', 'cans', 'tin', 'tins'],
  pinch: ['pinch', 'pinches'],
  slice: ['slice', 'slices'],
  bunch: ['bunch', 'bunches'],
  pack: ['pack', 'packs', 'package', 'packages', 'pkg'],
  piece: ['piece', 'pieces', 'pc', 'pcs'],
  handful: ['handful', 'handfuls'],
  sprig: ['sprig', 'sprigs'],
  stalk: ['stalk', 'stalks', 'rib', 'ribs'],
  dozen: ['dozen', 'doz'],
  head: ['head', 'heads'],
  jar: ['jar', 'jars'],
  bulb: ['bulb', 'bulbs'],
  'fl oz': ['floz', 'fl.oz'],
};
const UNIT_LOOKUP = new Map();
for (const [canon, list] of Object.entries(UNIT_ALIASES)) for (const a of list) UNIT_LOOKUP.set(a, canon);
export const UNIT_SUGGESTIONS = Object.keys(UNIT_ALIASES);
const MASS_UNITS = 'g|kg|oz|lb|lbs|ml|l';

/** 'Tablespoons' -> 'tbsp', 'T' -> 'tbsp'; unknown units are lower-cased and kept. */
export function normalizeUnit(unit) {
  if (!unit) return '';
  const raw = String(unit).trim().replace(/\.$/, '');
  if (raw === 'T' || raw === 'Tb' || raw === 'Tbs') return 'tbsp';
  return UNIT_LOOKUP.get(raw.toLowerCase()) ?? raw.toLowerCase();
}
/** Canonical unit for a known alias, or null. Single letters only count after a number. */
function knownUnit(raw, afterNumber) {
  const r = raw.replace(/\.$/, '');
  if (r === 'T') return 'tbsp';
  if (r.length === 1 && !afterNumber) return null;
  return UNIT_LOOKUP.get(r.toLowerCase()) ?? null;
}

// ------------------------------------------------------------------ numbers

const UNICODE_FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6 };
const UF = '¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚';
// Most specific first: "1 1/2", "1/2", "1½" / "½", then decimals ("0.5", "1,5") and whole numbers.
const NUMBER_RE = new RegExp(
  String.raw`^(?:(\d+)\s+(\d+)\s*/\s*(\d+)|(\d+)\s*/\s*(\d+)|(\d+)?\s*([${UF}])|(\d+(?:[.,]\d+)?))`,
);

/** Parse a leading amount. Returns { value, length } or null ("1/2 cup" -> 0.5, length 3). */
export function parseAmount(text) {
  const m = String(text).match(NUMBER_RE);
  if (!m) return null;
  let value = null;
  if (m[1] !== undefined) value = Number(m[1]) + (Number(m[3]) ? Number(m[2]) / Number(m[3]) : 0);
  else if (m[4] !== undefined) value = Number(m[5]) ? Number(m[4]) / Number(m[5]) : null;
  else if (m[7] !== undefined) value = (m[6] ? Number(m[6]) : 0) + UNICODE_FRACTIONS[m[7]];
  else if (m[8] !== undefined) value = Number(m[8].replace(',', '.'));
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return { value: Math.round(value * 1000) / 1000, length: m[0].length };
}

// ------------------------------------------------------------------ parsing

/**
 * Parse a free-text ingredient line:
 *   "1 1/2 cups flour, sifted"   -> { quantity: 1.5, unit: 'cup', name: 'flour', note: 'sifted' }
 *   "1/2 cup parmesan"          -> { quantity: 0.5, unit: 'cup', name: 'parmesan', note: null }
 *   "2-3 cloves garlic"         -> { quantity: 3, unit: 'clove', name: 'garlic', note: '2–3' }
 *   "1 (14 oz) can beans"       -> { quantity: 1, unit: 'can', name: 'beans', note: '14 oz' }
 *   "2 x 400g cans tomatoes"    -> { quantity: 2, unit: 'can', name: 'tomatoes', note: '400 g each' }
 */
export function parseIngredientLine(line) {
  let s = String(line ?? '').trim().replace(/^[-*•]\s*/, '');
  if (!s) return null;
  // Every parenthetical becomes a note: "1 (14 oz) can beans", "1 cup (240 ml) water", "oil (extra virgin)".
  const parenNotes = [];
  s = s.replace(/\s*\(([^)]*)\)\s*/g, (_, inner) => {
    if (inner.trim()) parenNotes.push(inner.trim());
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  // A comma starts a note — except a decimal comma like "1,5 l".
  let commaNote = null;
  const comma = s.search(/,(?!\d)|(?<!\d),/);
  if (comma > 0) {
    commaNote = s.slice(comma + 1).trim() || null;
    s = s.slice(0, comma).trim();
  }
  const lead = [];

  let quantity = null;
  const first = parseAmount(s);
  if (first) {
    quantity = first.value;
    s = s.slice(first.length);
    // Range "2-3" / "2 to 3": buy for the upper bound, keep the range as a note.
    const range = s.match(/^\s*(?:-|–|—|to)\s*/);
    if (range) {
      const second = parseAmount(s.slice(range[0].length));
      if (second && second.value > quantity) {
        lead.push(`${fmtQty(quantity)}–${fmtQty(second.value)}`);
        quantity = second.value;
        s = s.slice(range[0].length + second.length);
      }
    }
    s = s.trimStart();
    // Multipack: "2 x 400g cans tomatoes"
    const multi = s.match(new RegExp(String.raw`^[x×]\s*(\d+(?:[.,]\d+)?)\s*(${MASS_UNITS})\b\.?\s*`, 'i'));
    if (multi) {
      lead.push(`${multi[1].replace(',', '.')} ${normalizeUnit(multi[2])} each`);
      s = s.slice(multi[0].length);
    }
  }

  let unit = null;
  const floz = s.match(/^fl\.?\s*oz\.?\s+(.+)$/i);
  if (floz) {
    unit = 'fl oz';
    s = floz[1];
  } else {
    const um = s.match(/^([A-Za-z]+\.?)(?:\s+(?:of\s+)?|$)(.*)$/);
    if (um && um[2]) {
      const canon = knownUnit(um[1], quantity != null);
      if (canon) {
        unit = canon;
        s = um[2];
      }
    }
  }
  const tasteNote = s.match(/\s+(to taste|as needed|for serving|to serve|optional)$/i);
  if (tasteNote && tasteNote.index > 0) {
    lead.push(tasteNote[1].toLowerCase());
    s = s.slice(0, tasteNote.index);
  }
  const name = s.trim();
  if (!name) return null;
  const note = [...lead, ...parenNotes, commaNote].filter(Boolean).join(', ') || null;
  return splitCountNoun({ quantity, unit, name, note });
}

// "garlic cloves" / "celery stalks" / "thyme sprigs" / "garlic head(s)|bulb(s)": the trailing count noun
// is really the unit, so "4 garlic cloves" and "2 cloves garlic" become the same thing. "ground cloves" and
// "whole cloves" (the spice) are left alone.
const COUNT_NOUNS = { clove: 'clove', cloves: 'clove', stalk: 'stalk', stalks: 'stalk', sprig: 'sprig', sprigs: 'sprig', head: 'head', heads: 'head', bulb: 'bulb', bulbs: 'bulb', rib: 'stalk', ribs: 'stalk' };
/** Move a trailing count noun into the unit: { name: 'garlic cloves' } -> { unit: 'clove', name: 'garlic' }. */
export function splitCountNoun(ing) {
  if (!ing || ing.unit) return ing;
  const m = String(ing.name).match(/^(.+?)\s+(\p{L}+)$/u);
  if (!m) return ing;
  const unit = COUNT_NOUNS[m[2].toLowerCase()];
  if (!unit || /^(ground|whole)$/i.test(m[1].trim())) return ing;
  return { ...ing, unit, name: m[1].trim() };
}

// ------------------------------------------------------------------ formatting

const FRACTION_GLYPHS = [[0.125, '⅛'], [0.25, '¼'], [1 / 3, '⅓'], [0.375, '⅜'], [0.5, '½'], [0.625, '⅝'], [2 / 3, '⅔'], [0.75, '¾'], [0.875, '⅞']];
/** Round to a friendly precision (0.33333 -> 0.33, 2.0 -> 2). */
export function roundQty(n) {
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}
/** 1.5 -> "1½", 0.25 -> "¼", 3 -> "3", 1.23 -> "1.23". */
export function fmtQty(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (frac < 0.02) return String(whole);
  for (const [v, glyph] of FRACTION_GLYPHS) if (Math.abs(frac - v) < 0.02) return `${whole || ''}${glyph}`;
  return String(roundQty(n));
}

const PLURAL_UNITS = new Set(['cup', 'clove', 'can', 'slice', 'bunch', 'pack', 'piece', 'handful', 'sprig', 'stalk', 'head', 'jar', 'pinch', 'bulb']);
/** "cup" -> "cups" when qty > 1. */
export function unitLabel(unit, qty) {
  if (!unit) return '';
  if (PLURAL_UNITS.has(unit) && qty != null && qty > 1) return unit === 'bunch' || unit === 'pinch' ? `${unit}es` : `${unit}s`;
  return unit;
}

// ------------------------------------------------------------------ plurals

const MASS_NOUNS = new Set([
  'salt', 'rice', 'garlic', 'flour', 'sugar', 'butter', 'milk', 'cream', 'water', 'oil', 'cheese', 'feta', 'parmesan',
  'mozzarella', 'cheddar', 'spinach', 'lettuce', 'kale', 'broccoli', 'asparagus', 'fish', 'salmon', 'tuna', 'cod', 'shrimp',
  'yogurt', 'yoghurt', 'honey', 'bread', 'pasta', 'basil', 'parsley', 'cilantro', 'dill', 'mint', 'thyme', 'rosemary', 'oregano',
  'celery', 'corn', 'beef', 'pork', 'chicken', 'lamb', 'bacon', 'ham', 'mince', 'syrup', 'passata', 'couscous', 'quinoa', 'tofu',
]);
const IRREGULAR_PLURAL = { leaf: 'leaves', loaf: 'loaves', knife: 'knives', half: 'halves', tomato: 'tomatoes', potato: 'potatoes', mango: 'mangoes', hero: 'heroes' };
const IRREGULAR_SINGULAR = Object.fromEntries(Object.entries(IRREGULAR_PLURAL).map(([a, b]) => [b, a]));
const keepCase = (orig, repl) => (orig[0] === orig[0].toUpperCase() ? repl[0].toUpperCase() + repl.slice(1) : repl);

function looksPlural(w) {
  if (IRREGULAR_SINGULAR[w]) return true;
  return w.length > 2 && w.endsWith('s') && !/(ss|us|is)$/u.test(w);
}
/** "egg" -> "eggs", "berry" -> "berries", "jalapeño" -> "jalapeños"; plurals and mass nouns unchanged. */
export function pluralWord(w) {
  const lower = w.toLowerCase();
  if (MASS_NOUNS.has(lower) || looksPlural(lower) || /(us|ss)$/u.test(lower)) return w;
  if (IRREGULAR_PLURAL[lower]) return keepCase(w, IRREGULAR_PLURAL[lower]);
  if (/[^aeiou]y$/iu.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(ch|sh|x|z)$/iu.test(w)) return `${w}es`;
  return `${w}s`;
}
/** "berries" -> "berry", "leaves" -> "leaf", "peaches" -> "peach"; singular words unchanged. */
export function singularWord(w) {
  const lower = w.toLowerCase();
  if (IRREGULAR_SINGULAR[lower]) return keepCase(w, IRREGULAR_SINGULAR[lower]);
  if (!looksPlural(lower)) return w;
  if (/[^aeiou]ies$/iu.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes|sses)$/iu.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}
/** Name as it reads after a bare count: ("egg", 6) -> "eggs", ("tomatoes", 1) -> "tomato". Only the last word changes. */
export function nameForCount(name, qty, unit) {
  if (unit || qty === null || qty === undefined || !name) return name;
  const m = String(name).match(/^(.*?)(\p{L}+)$/u);
  if (!m) return name;
  return m[1] + (qty > 1 ? pluralWord(m[2]) : singularWord(m[2]));
}

/** Singular-ish, lower-cased key for grouping names ("Tomatoes" ~ "tomato", "bay leaves" ~ "bay leaf"). */
export function nameKey(name) {
  const s = String(name || '').toLowerCase().trim().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ');
  const last = words.pop() ?? '';
  return [...words, singularWord(last)].join(' ');
}

// Weights and metric volumes read best as decimals ("1.38 kg"); cups and spoons as fractions ("1⅜ cups").
const DECIMAL_UNITS = new Set(['g', 'kg', 'ml', 'l', 'oz', 'lb', 'fl oz']);
/** The amount part of a line: "164 g", "1⅜ cups", "3", "" (no quantity). */
export function amountText(quantity, unit) {
  if (quantity === null || quantity === undefined) return unit ? unitLabel(unit, null) : '';
  const q = DECIMAL_UNITS.has(unit) ? String(roundQty(quantity)) : fmtQty(quantity);
  return [q, unitLabel(unit, quantity)].filter(Boolean).join(' ');
}

/** Human line: "2 cups flour", "3 eggs", "Salt". */
export function ingredientText({ quantity, unit, name }) {
  return [amountText(quantity, unit), nameForCount(name, quantity, unit)].filter(Boolean).join(' ');
}
