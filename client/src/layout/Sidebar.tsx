import { NavLink } from 'react-router';
import { Settings, Users, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { modules } from '../modules/registry';
import { FamilySwitcher } from './FamilySwitcher';
import { Logo } from './Logo';
import { UserMenu } from './UserMenu';
import { NavBadge } from './NavBadge';
import type { ModuleDef } from '../modules/types';

function NavItem({ to, label, icon: Icon, accent, mod }: { to: string; label: string; icon: LucideIcon; accent: string; mod?: ModuleDef }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] font-medium transition-colors duration-150',
          isActive ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
      style={({ isActive }) => (isActive ? { backgroundColor: `color-mix(in oklab, ${accent} 11%, var(--surface))` } : undefined)}
    >
      {({ isActive }) => (
        <>
          <span
            className={cn('flex size-8 items-center justify-center rounded-lg transition-colors', !isActive && 'group-hover:text-fg')}
            style={isActive ? { backgroundColor: accent, color: 'white' } : { color: accent }}
          >
            <Icon size={17} strokeWidth={isActive ? 2.25 : 2} />
          </span>
          <span className={cn('flex-1', isActive && 'font-semibold')}>{label}</span>
          {mod && <NavBadge mod={mod} />}
        </>
      )}
    </NavLink>
  );
}

/** Desktop left sidebar (≥1024px). */
export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-border bg-surface/70 backdrop-blur-xl lg:flex">
      <div className="px-5 pb-4 pt-6">
        <Logo />
      </div>
      <div className="px-3 pb-3">
        <FamilySwitcher />
      </div>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2 scrollbar-thin">
        {modules.map((m) => (
          <NavItem key={m.id} to={m.path} label={m.label} icon={m.icon} accent={m.accent} mod={m} />
        ))}
        <div className="mx-3 my-3 h-px bg-border" />
        <NavItem to="/family" label="Family" icon={Users} accent="#F76B15" />
        <NavItem to="/settings" label="Settings" icon={Settings} accent="#737889" />
      </nav>
      <div className="border-t border-border p-3">
        <UserMenu />
      </div>
    </aside>
  );
}
