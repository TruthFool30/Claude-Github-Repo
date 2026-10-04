import { lazy } from 'react';
import { MapPin } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'locator',
  label: 'Locator',
  icon: MapPin,
  path: '/locator',
  element: lazy(() => import('./LocatorPage')),
  nav: 'secondary',
  order: 80,
  accent: '#E5484D',
  description: 'Places and check-ins',
};

export default mod;
