import type { ModuleDef } from '../modules/types';
import { cn } from '../lib/cn';

function Count({ useBadge, className }: { useBadge: NonNullable<ModuleDef['useBadge']>; className?: string }) {
  const n = useBadge() ?? 0;
  if (n <= 0) return null;
  return (
    <>
      <span className="sr-only">, {n} new</span>
      <span
      aria-hidden="true"
      className={cn(
        'inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger-solid px-1.5 text-[10.5px] font-bold leading-[18px] text-white tabular-nums',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
      </span>
    </>
  );
}

/** Unread/attention badge for a module's nav item (renders nothing when the module has no badge hook). */
export function NavBadge({ mod, className }: { mod: Pick<ModuleDef, 'useBadge'>; className?: string }) {
  return mod.useBadge ? <Count useBadge={mod.useBadge} className={className} /> : null;
}

function useSecondaryTotal(hooks: NonNullable<ModuleDef['useBadge']>[]) {
  // `hooks` comes from the static module registry, so the call order never changes.
  let total = 0;
  for (const h of hooks) total += h() ?? 0;
  return total;
}

/** Small dot on the mobile "More" tab when any module inside the More sheet has a badge. */
export function MoreDot({ mods, className }: { mods: Pick<ModuleDef, 'useBadge'>[]; className?: string }) {
  const hooks = mods.flatMap((m) => (m.useBadge ? [m.useBadge] : []));
  const total = useSecondaryTotal(hooks);
  if (total <= 0) return null;
  return (
    <>
      <span className="sr-only">, {total} new</span>
      <span aria-hidden="true" className={cn('size-2.5 rounded-full bg-danger-solid ring-2 ring-surface', className)} />
    </>
  );
}
