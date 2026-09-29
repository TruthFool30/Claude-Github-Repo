import { lazy } from 'react';
import { Wallet } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'budget',
  label: 'Budget',
  icon: Wallet,
  path: '/budget',
  element: lazy(() => import('./BudgetPage')),
  nav: 'secondary',
  order: 70,
  accent: '#12A594',
  description: 'Track spending and shared expenses',
};

export default mod;
