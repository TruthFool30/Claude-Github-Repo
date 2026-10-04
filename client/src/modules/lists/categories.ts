// Aisle helpers. The classifier and its keyword data are shared with the server (imported straight
// from /shared/lists/), so the add bar's preview always matches what gets saved.
import aisles from '../../../../shared/lists/aisles.json';
import { createClassifier, parseQuantity } from '../../../../shared/lists/classify.js';
import type { ListType } from './types';

export const CATEGORIES: readonly string[] = aisles.categories;

export const CATEGORY_EMOJI: Record<string, string> = {
  Produce: '🥬', Bakery: '🥖', Dairy: '🧀', Meat: '🥩', Pantry: '🥫', Frozen: '🧊', Drinks: '🧃', Snacks: '🍪',
  Household: '🧻', 'Personal care': '🧴', Other: '🛍️',
};

export const categoryEmoji = (c: string | null | undefined) => CATEGORY_EMOJI[c ?? 'Other'] ?? '🏷️';

/** Aisle sort order; unknown categories (e.g. "Herbs" from Meals) go before Other, alphabetically. */
export function categoryRank(c: string | null | undefined): number {
  const i = CATEGORIES.indexOf(c ?? 'Other');
  return i >= 0 ? (c === 'Other' ? 1000 : i) : 500;
}

const classifier = createClassifier(aisles);

/** Same classifier the server uses (shared code + data), for the live "goes in Dairy" preview. */
export const guessCategory = classifier.guessCategory;
export { parseQuantity };

export const TYPE_META: Record<ListType, { label: string; plural: string; icon: string; color: string; hint: string }> = {
  shopping: { label: 'Shopping', plural: 'Shopping', icon: '🛒', color: '#30A46C', hint: 'Items are sorted by aisle automatically' },
  todo: { label: 'To-do', plural: 'To-dos', icon: '✅', color: '#5B5BD6', hint: 'Assign tasks and set due dates' },
  other: { label: 'Other', plural: 'Other', icon: '📝', color: '#F76B15', hint: 'Packing lists, ideas, anything' },
};

export const EMOJIS = [
  '🛒', '🛍️', '🥕', '🍎', '🧀', '🍕', '✅', '🧹', '🧺', '🛠️', '🏡', '🌱', '🐶', '🎒', '📚', '💊',
  '🧳', '🏖️', '⛺', '✈️', '🎁', '🎄', '🎂', '🎉', '📝', '💡', '🎬', '📖', '💪', '⚽', '🚗', '❤️',
];
