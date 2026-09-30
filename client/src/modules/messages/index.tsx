import { lazy } from 'react';
import { MessageCircle } from 'lucide-react';
import type { ModuleDef } from '../types';
import { useUnreadBadge } from './data';

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
  // Total unread across my (unmuted) conversations; shared query ['messages','unread'] kept live.
  useBadge: useUnreadBadge,
};

export default mod;
