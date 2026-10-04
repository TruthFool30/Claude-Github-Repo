// "Is this ingredient already on the shopping list?" — shared by the Meals dialog (client) and tests.
// Uses the Lists module's own name normaliser (/shared/lists/classify.js: lower-case, accents folded,
// singular stems) so "Avocados" ≈ "avocado". Deliberately conservative: a false "already on list"
// would silently drop something from the shopping trip.
import { tokenize } from '../lists/classify.js';

// Generic trailing nouns that don't change what you buy ("Cheddar cheese" is cheddar).
const GENERIC_TAIL = new Set(['cheese']);
// Qualifiers that make a different product ("Almond milk" isn't milk, "Sweet potato" isn't a potato).
const CHANGES_PRODUCT = new Set(['almond', 'oat', 'soy', 'coconut', 'rice', 'goat', 'sweet', 'spring', 'green', 'sour', 'condensed',
  'evaporated', 'powdered', 'peanut', 'sesame', 'hot', 'chili', 'chilli', 'cream', 'ice', 'plant', 'vegan', 'dried', 'frozen', 'canned']);

function core(tokens) {
  const t = [...tokens];
  while (t.length > 1 && GENERIC_TAIL.has(t[t.length - 1])) t.pop();
  return t;
}

/**
 * True when two grocery names mean the same thing:
 *  - identical after normalisation ("Avocados" / "1 avocado" name), or
 *  - same head noun (last word) and every word of the shorter name appears in the longer one
 *    ("Tortillas" ≈ "Small tortillas", "Cheddar" ≈ "Cheddar cheese").
 * Optionally pass `aisleOf(name)` (e.g. Lists' classifier) to also require the same aisle, which keeps
 * "Pepper" (produce) apart from "Black pepper" (pantry).
 */
export function sameGrocery(a, b, aisleOf) {
  const ta = core(tokenize(a));
  const tb = core(tokenize(b));
  if (!ta.length || !tb.length) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short[short.length - 1] !== long[long.length - 1]) return false;
  if (!short.every((w) => long.includes(w))) return false;
  if (long.some((w) => !short.includes(w) && CHANGES_PRODUCT.has(w))) return false;
  if (aisleOf && aisleOf(String(a)) !== aisleOf(String(b))) return false;
  return true;
}
