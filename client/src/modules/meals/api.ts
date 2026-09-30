import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';

export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Ingredient {
  id?: number;
  quantity: number | null;
  unit: string | null;
  name: string;
  note: string | null;
}

export interface RecipeSummary {
  id: number;
  title: string;
  description: string | null;
  photo_url: string | null;
  icon: string;
  color: string;
  servings: number;
  prep_minutes: number;
  cook_minutes: number;
  total_minutes: number;
  tags: string[];
  source_url: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  favorite: boolean;
  favorited_by: number[];
  ingredient_count: number;
  step_count: number;
  plan_count: number;
  last_planned: string | null;
  next_planned: string | null;
}

export interface Recipe extends RecipeSummary {
  ingredients: Ingredient[];
  steps: string[];
  upcoming: { id: number; date: string; slot: Slot; cook_id: number | null }[];
}

export interface PlanEntry {
  id: number;
  date: string;
  slot: Slot;
  position: number;
  recipe_id: number | null;
  title: string;
  note: string | null;
  servings: number | null;
  cook_id: number | null;
  created_by: number | null;
  created_at: string;
  recipe: { id: number; title: string; photo_url: string | null; icon: string; color: string; servings: number; total_minutes: number } | null;
}

export interface PlanResponse {
  start: string;
  end: string;
  days: number;
  entries: PlanEntry[];
}

export interface ShoppingItem {
  key: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  text: string;
  /** Capitalised name as it reads after the amount ("Eggs"), for Lists items. */
  label: string;
  /** "164 g", "3", "1⅜ cups" — sent to Lists as the item's quantity chip. */
  amount: string | null;
  /** One of the Lists module's canonical aisles. */
  category: string;
  recipes: string[];
}

export interface IngredientsResponse {
  start: string;
  end: string;
  meal_count: number;
  free_text: { id: number; date: string; slot: Slot; title: string }[];
  items: ShoppingItem[];
}

export interface RecipeInput {
  title: string;
  description: string | null;
  servings: number;
  prep_minutes: number;
  cook_minutes: number;
  tags: string[];
  icon: string;
  color: string;
  source_url: string | null;
  ingredients: Ingredient[];
  steps: string[];
}

export interface PlanInput {
  date: string;
  slot: Slot;
  recipe_id?: number | null;
  title?: string | null;
  note?: string | null;
  servings?: number | null;
  cook_id?: number | null;
}

export type RecipeSort = 'recent' | 'title' | 'quick' | 'popular';

export const keys = {
  recipes: (params: { q?: string; tag?: string; favorites?: boolean; sort?: RecipeSort } = {}) => ['meals', 'recipes', params] as const,
  recipe: (id: number) => ['meals', 'recipe', id] as const,
  tags: ['meals', 'tags'] as const,
  plan: (start: string) => ['meals', 'plan', start] as const,
  ingredients: (start: string) => ['meals', 'ingredients', start] as const,
};

export function useRecipes(params: { q?: string; tag?: string; favorites?: boolean; sort?: RecipeSort } = {}) {
  return useQuery({
    queryKey: keys.recipes(params),
    queryFn: () =>
      api.get<RecipeSummary[]>(`/meals/recipes${qs({ q: params.q, tag: params.tag, favorites: params.favorites ? 1 : null, sort: params.sort })}`),
    placeholderData: (prev) => prev,
  });
}

export function useRecipe(id: number) {
  return useQuery({ queryKey: keys.recipe(id), queryFn: () => api.get<Recipe>(`/meals/recipes/${id}`), enabled: Number.isInteger(id) && id > 0 });
}

export function useTags() {
  return useQuery({ queryKey: keys.tags, queryFn: () => api.get<{ tag: string; count: number }[]>('/meals/recipes/tags') });
}

export function usePlan(start: string) {
  return useQuery({ queryKey: keys.plan(start), queryFn: () => api.get<PlanResponse>(`/meals/plan${qs({ start, days: 7 })}`), placeholderData: (prev) => prev });
}

/** Optimistic favorite toggle across every cached recipe list/detail. */
export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: number; favorite: boolean }) =>
      api.put<{ id: number; favorite: boolean; favorited_by: number[] }>(`/meals/recipes/${id}/favorite`, { favorite }),
    onMutate: async ({ id, favorite }) => {
      await qc.cancelQueries({ queryKey: ['meals', 'recipes'] });
      await qc.cancelQueries({ queryKey: keys.recipe(id) });
      const snapshot = qc.getQueriesData({ queryKey: ['meals'] });
      const patch = <T extends RecipeSummary>(r: T): T => (r.id === id ? { ...r, favorite } : r);
      qc.setQueriesData<RecipeSummary[]>({ queryKey: ['meals', 'recipes'] }, (old) => old?.map(patch));
      qc.setQueryData<Recipe>(keys.recipe(id), (old) => (old ? patch(old) : old));
      return { snapshot };
    },
    onError: (_e, _v, context) => {
      context?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['meals'] }),
  });
}
