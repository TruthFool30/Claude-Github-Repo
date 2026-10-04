import { lazy } from 'react';
import { CalendarDays } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'calendar',
  label: 'Calendar',
  icon: CalendarDays,
  path: '/calendar',
  element: lazy(() => import('./CalendarPage')),
  nav: 'primary',
  order: 20,
  accent: '#0090FF',
  description: 'Events, birthdays and schedules for everyone',
};

export default mod;
