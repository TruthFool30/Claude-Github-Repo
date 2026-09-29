import { lazy } from 'react';
import { House } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'wall',
  label: 'Home',
  icon: House,
  path: '/home',
  element: lazy(() => import('./WallPage')),
  nav: 'primary',
  order: 10,
  accent: '#5B5BD6',
  description: "Your family's latest news and what's coming up",
};

export default mod;
