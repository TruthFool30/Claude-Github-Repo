import { Users, Bell, type LucideIcon } from 'lucide-react';
import { moduleById } from '../modules/registry';

/** Icon + accent + label for a module id, including core pseudo-modules like 'family'. */
export function moduleMeta(id: string | null | undefined): { icon: LucideIcon; accent: string; label: string } {
  if (id && moduleById[id]) {
    const m = moduleById[id];
    return { icon: m.icon, accent: m.accent, label: m.label };
  }
  if (id === 'family') return { icon: Users, accent: '#F76B15', label: 'Family' };
  return { icon: Bell, accent: '#5B5BD6', label: 'Hearth' };
}
