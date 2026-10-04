// Types for shared/meals/ingredients.js (used by the web client).
export interface ParsedIngredient {
  quantity: number | null;
  unit: string | null;
  name: string;
  note: string | null;
}
export const UNIT_SUGGESTIONS: string[];
export function normalizeUnit(unit: string | null | undefined): string;
export function parseAmount(text: string): { value: number; length: number } | null;
export function splitCountNoun<T extends { quantity: number | null; unit: string | null; name: string }>(ing: T): T;
export function parseIngredientLine(line: string | null | undefined): ParsedIngredient | null;
export function roundQty(n: number): number;
export function fmtQty(n: number | null | undefined): string;
export function unitLabel(unit: string | null | undefined, qty: number | null | undefined): string;
export function pluralWord(word: string): string;
export function singularWord(word: string): string;
export function nameForCount(name: string, qty: number | null | undefined, unit: string | null | undefined): string;
export function nameKey(name: string): string;
export function ingredientText(i: { quantity: number | null; unit: string | null; name: string }): string;
export function amountText(quantity: number | null | undefined, unit: string | null | undefined): string;
