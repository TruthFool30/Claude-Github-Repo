import {
  Apple, Beef, Cake, Carrot, Cherry, Citrus, Coffee, Cookie, CookingPot, Croissant, Drumstick, Egg, Fish, IceCreamCone,
  Moon, Pizza, Popcorn, Salad, Sandwich, Soup, Sun, Sunrise, Utensils, Wheat, type LucideIcon,
} from 'lucide-react';
import { addDays, format, startOfWeek } from 'date-fns';
import { toDate, toDateKey } from '../../lib/format';
import type { Ingredient, Slot } from './api';
// One parser/wording implementation shared with the server (see shared/meals/ingredients.js).
import { amountText, fmtQty, nameForCount, parseAmount, parseIngredientLine, unitLabel, UNIT_SUGGESTIONS } from '../../../../shared/meals/ingredients.js';

export { fmtQty, parseAmount, parseIngredientLine, unitLabel, UNIT_SUGGESTIONS };

export const ACCENT = '#F76B15';
/** Filled backgrounds under white text (>=4.5:1 with white). */
export const ACCENT_SOLID = '#C2410C';

export const SLOTS: { id: Slot; label: string; icon: LucideIcon; color: string }[] = [
  { id: 'breakfast', label: 'Breakfast', icon: Sunrise, color: '#FFB224' },
  { id: 'lunch', label: 'Lunch', icon: Sun, color: '#30A46C' },
  { id: 'dinner', label: 'Dinner', icon: Moon, color: '#5B5BD6' },
  { id: 'snack', label: 'Snack', icon: Popcorn, color: '#D6409F' },
];
export const slotMeta = (slot: Slot) => SLOTS.find((s) => s.id === slot) ?? SLOTS[2];

export const RECIPE_ICONS: Record<string, LucideIcon> = {
  utensils: Utensils, soup: Soup, salad: Salad, pizza: Pizza, sandwich: Sandwich, beef: Beef, fish: Fish, egg: Egg,
  croissant: Croissant, cake: Cake, cookie: Cookie, apple: Apple, carrot: Carrot, drumstick: Drumstick, coffee: Coffee,
  'ice-cream': IceCreamCone, wheat: Wheat, 'cooking-pot': CookingPot, cherry: Cherry, citrus: Citrus,
};
export const recipeIcon = (key: string | null | undefined) => RECIPE_ICONS[key ?? ''] ?? Utensils;

export const RECIPE_COLORS = ['#F76B15', '#E5484D', '#FFB224', '#30A46C', '#12A594', '#0090FF', '#5B5BD6', '#8E4EC6', '#D6409F', '#978365'];

// ---------------------------------------------------------------- weeks

/** Monday ('YYYY-MM-DD') of the week containing `date`. */
export function weekStart(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? toDate(date)! : date;
  return toDateKey(startOfWeek(d, { weekStartsOn: 1 }));
}
export const shiftDays = (key: string, n: number) => toDateKey(addDays(toDate(key)!, n));
export const weekDays = (start: string) => Array.from({ length: 7 }, (_, i) => shiftDays(start, i));

/** "Sep 28 – Oct 4" */
export function weekLabel(start: string): string {
  const a = toDate(start)!;
  const b = addDays(a, 6);
  const sameMonth = a.getMonth() === b.getMonth();
  const year = a.getFullYear() !== new Date().getFullYear() || b.getFullYear() !== a.getFullYear() ? `, ${format(b, 'yyyy')}` : '';
  return `${format(a, 'MMM d')} – ${format(b, sameMonth ? 'd' : 'MMM d')}${year}`;
}

export function relativeWeek(start: string): string | null {
  const diff = Math.round((toDate(start)!.getTime() - toDate(weekStart())!.getTime()) / (7 * 864e5));
  if (diff === 0) return 'This week';
  if (diff === 1) return 'Next week';
  if (diff === -1) return 'Last week';
  return null;
}

// ---------------------------------------------------------------- formatting

/** 75 -> "1 h 15 min", 30 -> "30 min", 0 -> "" */
export function fmtMinutes(min: number | null | undefined): string {
  const m = Number(min ?? 0);
  if (!m) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function amountLabel(ing: Pick<Ingredient, 'quantity' | 'unit'>, factor = 1): string {
  let q = ing.quantity != null ? ing.quantity * factor : null;
  let unit = ing.unit;
  if (q != null && q >= 1000 && (unit === 'g' || unit === 'ml')) {
    q /= 1000;
    unit = unit === 'g' ? 'kg' : 'l';
  }
  return amountText(q, unit);
}

/** "egg" after "6" reads "eggs"; "tomatoes" after "1" reads "tomato". Only bare counts (no unit) change. */
export function ingredientName(ing: Pick<Ingredient, 'quantity' | 'unit' | 'name'>, factor = 1): string {
  return nameForCount(ing.name, ing.quantity != null ? ing.quantity * factor : null, ing.unit);
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const DURATION_RE = /(\d+(?:[.,]\d+)?|an?|one|half an?)\s*(?:[–-]\s*(\d+(?:[.,]\d+)?)\s*)?(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m)\b/gi;
const unitSeconds = (u: string) => (u.startsWith('s') ? 1 : u.startsWith('h') ? 3600 : 60);
const numberOf = (raw: string) => {
  const r = raw.toLowerCase();
  if (r === 'a' || r === 'an' || r === 'one') return 1;
  if (r.startsWith('half')) return 0.5;
  return Number(r.replace(',', '.'));
};

/**
 * Find a duration in a step for a one-tap timer: "10 minutes", "1 hour 30 minutes", "1 h 15 min",
 * "an hour and a half"-style phrases are summed when they are adjacent. Ranges use the upper bound.
 */
export function findTimer(step: string): { seconds: number; label: string } | null {
  const matches = [...step.matchAll(DURATION_RE)];
  if (!matches.length) return null;
  // Group the first run of adjacent durations ("1 hour 30 minutes", "1 hour and 15 minutes").
  let seconds = 0;
  let start = matches[0].index ?? 0;
  let end = start;
  for (const [i, m] of matches.entries()) {
    const idx = m.index ?? 0;
    if (i > 0 && !/^\s*(and|,)?\s*$/i.test(step.slice(end, idx))) break;
    const n = numberOf(m[2] ?? m[1]);
    if (!Number.isFinite(n)) break;
    seconds += n * unitSeconds(m[3].toLowerCase());
    end = idx + m[0].length;
    if (i === 0) start = idx;
  }
  if (/\band a half\b/i.test(step.slice(end, end + 12))) {
    const unit = matches[0][3].toLowerCase();
    seconds += 0.5 * unitSeconds(unit);
    end += step.slice(end).match(/^\s*and a half/i)?.[0].length ?? 0;
  }
  seconds = Math.round(seconds);
  if (!seconds || seconds > 12 * 3600) return null;
  return { seconds, label: step.slice(start, end).trim() };
}

export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
