import type { ModuleDef } from '../modules/types';
import { cn } from '../lib/cn';

function Count({ useBadge, className }: { useBadge: NonNullable<ModuleDef['useBadge']>; className?: string }) {
  const n = useBadge() ?? 0;
  if (n <= 0) return null;
  return (
    <span
      aria-label={`${n} new`}
      className={cn(
        'inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger-solid px-1.5 text-[10.5px] font-bold leading-[18px] text-white tabular-nums',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** Unread/attention badge for a module's nav item (renders nothing when the module has no badge hook). */
export function NavBadge({ mod, className }: { mod: Pick<ModuleDef, 'useBadge'>; className?: string }) {
  return mod.useBadge ? <Count useBadge={mod.useBadge} className={className} /> : null;
}
