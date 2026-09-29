import { lazy } from 'react';
import { Images } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'photos',
  label: 'Photos',
  icon: Images,
  path: '/photos',
  element: lazy(() => import('./PhotosPage')),
  nav: 'secondary',
  order: 50,
  accent: '#D6409F',
  description: 'Shared albums and memories',
};

export default mod;
