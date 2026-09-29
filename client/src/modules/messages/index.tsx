import { lazy } from 'react';
import { MessageCircle } from 'lucide-react';
import type { ModuleDef } from '../types';

const mod: ModuleDef = {
  id: 'messages',
  label: 'Messages',
  icon: MessageCircle,
  path: '/messages',
  element: lazy(() => import('./MessagesPage')),
  nav: 'primary',
  order: 40,
  accent: '#8E4EC6',
  description: 'Family chat and group conversations',
};

export default mod;
