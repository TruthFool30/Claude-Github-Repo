import { lazy } from 'react';
import { UtensilsCrossed } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'meals',
  label: 'Meals',
  icon: UtensilsCrossed,
  path: '/meals',
  element: lazy(() => import('./MealsPage')),
  nav: 'secondary',
  order: 60,
  accent: '#F76B15',
  description: 'Recipes and the weekly meal plan',
};

export default mod;
