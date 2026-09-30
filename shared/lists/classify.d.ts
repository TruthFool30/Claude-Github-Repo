// Types for classify.js (imported by the TypeScript client).
export interface AisleData {
  categories: string[];
  modifiers: Record<string, string>;
  keywords: Record<string, string[]>;
}
export function stem(word: string): string;
export function tokenize(text: string): string[];
export function createClassifier(data: AisleData): { categories: string[]; guessCategory: (text: string) => string };
export function parseQuantity(text: string): { text: string; quantity: string | null };
