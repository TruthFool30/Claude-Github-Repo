import { lazy } from 'react';
import { BookUser } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'vault',
  label: 'Contacts & Docs',
  icon: BookUser,
  shortLabel: 'Vault',
  path: '/vault',
  element: lazy(() => import('./VaultPage')),
  nav: 'secondary',
  order: 90,
  accent: '#978365',
  description: 'Important contacts and documents',
};

export default mod;
