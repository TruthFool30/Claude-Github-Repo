// Shopping aisles + item-name classifier (server side). Data + algorithm live in /shared/lists/ (aisles.json, classify.js) —
// both are imported by the web client too, so the live preview matches what the server stores.
import fs from 'node:fs';
import { createClassifier, parseQuantity } from '../../../../shared/lists/classify.js';

const DATA = JSON.parse(fs.readFileSync(new URL('../../../../shared/lists/aisles.json', import.meta.url), 'utf8'));
const classifier = createClassifier(DATA);

/** Aisle order used to group shopping lists. */
export const CATEGORIES = classifier.categories;
export const guessCategory = classifier.guessCategory;
export { parseQuantity };

/** Canonical category name for a user/API-supplied value (case-insensitive match), else the value. */
export function normalizeCategory(value) {
  const hit = CATEGORIES.find((c) => c.toLowerCase() === value.toLowerCase());
  return hit ?? value;
}
