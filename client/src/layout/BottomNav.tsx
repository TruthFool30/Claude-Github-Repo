import { NavLink, useLocation } from 'react-router';
import { LayoutGrid } from 'lucide-react';
import { cn } from '../lib/cn';
import { setShell, useShell } from '../lib/shell';
import { primaryModules, secondaryModules } from '../modules/registry';
import { NavBadge } from './NavBadge';

/** Mobile bottom tab bar: 4 primary modules + "More". */
export function BottomNav() {
  const { moreOpen } = useShell();
  const { pathname } = useLocation();
  const inSecondary =
    secondaryModules.some((m) => pathname.startsWith(m.path)) || pathname.startsWith('/family') || pathname.startsWith('/settings');
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/85 backdrop-blur-xl backdrop-saturate-150 lg:hidden"
    >
      <div className="mx-auto flex h-16 max-w-lg items-stretch px-1">
        {primaryModules.map((m) => (
          <NavLink key={m.id} to={m.path} className="group flex flex-1 flex-col items-center justify-center gap-1">
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'relative flex h-8 w-14 items-center justify-center rounded-full transition-all duration-200',
                    isActive ? 'scale-100' : 'text-muted group-active:scale-90',
                  )}
                  style={isActive ? { backgroundColor: `color-mix(in oklab, ${m.accent} 16%, transparent)`, color: m.accent } : undefined}
                >
                  <m.icon size={21} strokeWidth={isActive ? 2.4 : 2} />
                  <NavBadge mod={m} className="absolute -top-1 right-1.5 ring-2 ring-surface" />
                </span>
                <span className={cn('text-[11px] leading-none', isActive ? 'font-bold text-fg' : 'font-medium text-muted')}>
                  {m.shortLabel ?? m.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setShell({ moreOpen: true })}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className="group flex flex-1 flex-col items-center justify-center gap-1"
        >
          <span
            className={cn(
              'flex h-8 w-14 items-center justify-center rounded-full transition-all duration-200 group-active:scale-90',
              inSecondary || moreOpen ? 'bg-primary-soft text-primary' : 'text-muted',
            )}
          >
            <LayoutGrid size={21} strokeWidth={inSecondary ? 2.4 : 2} />
          </span>
          <span className={cn('text-[11px] leading-none', inSecondary ? 'font-bold text-fg' : 'font-medium text-muted')}>More</span>
        </button>
      </div>
    </nav>
  );
}
