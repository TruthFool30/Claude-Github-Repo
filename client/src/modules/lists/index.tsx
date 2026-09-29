import { lazy } from 'react';
import { ListChecks } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'lists',
  label: 'Lists',
  icon: ListChecks,
  path: '/lists',
  element: lazy(() => import('./ListsPage')),
  nav: 'primary',
  order: 30,
  accent: '#30A46C',
  description: 'Groceries, to-dos and chores',
};

export default mod;
