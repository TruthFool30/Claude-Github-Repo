import { lazy } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLive } from '../../lib/live';
import { Wallet } from 'lucide-react';
import type { ModuleDef } from '../types';

/** Bills that need attention this month (overdue / due today); 0 for kids. */
function useBudgetBadge() {
  const { familyId, role } = useAuth();
  useLive('budget', undefined, { queryKey: ['budget', 'badge'] });
  const { data } = useQuery({
    queryKey: ['budget', 'badge'],
    queryFn: () => api.get<{ bills_due: number }>('/budget/badge'),
    enabled: !!familyId && role !== 'child',
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
  });
  return role === 'child' ? 0 : data?.bills_due;
}

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
  useBadge: useBudgetBadge,
};

export default mod;
