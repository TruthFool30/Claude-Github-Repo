import type { ModuleDef } from '../modules/types';
import { cn } from '../lib/cn';

function Count({ useBadge, className, text = 'before' }: { useBadge: NonNullable<ModuleDef['useBadge']>; className?: string; text?: 'before' | 'none' }) {
  const n = useBadge() ?? 0;
  if (n <= 0) return null;
  return (
    <>
      {text === 'before' && <span className="sr-only">, {n} new</span>}
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
export function NavBadge({ mod, className, srText = true }: { mod: Pick<ModuleDef, 'useBadge'>; className?: string; srText?: boolean }) {
  return mod.useBadge ? <Count useBadge={mod.useBadge} className={className} text={srText ? 'before' : 'none'} /> : null;
}

function SrCount({ useBadge }: { useBadge: NonNullable<ModuleDef['useBadge']> }) {
  const n = useBadge() ?? 0;
  return n > 0 ? <span className="sr-only">, {n} new</span> : null;
}

/** Screen-reader-only ", N new" — place after the label when the visual badge sits before it. */
export function NavBadgeText({ mod }: { mod: Pick<ModuleDef, 'useBadge'> }) {
  return mod.useBadge ? <SrCount useBadge={mod.useBadge} /> : null;
}

function useSecondaryTotal(hooks: NonNullable<ModuleDef['useBadge']>[]) {
  // `hooks` comes from the static module registry, so the call order never changes.
  let total = 0;
  for (const h of hooks) total += h() ?? 0;
  return total;
}

/** Small dot on the mobile "More" tab when any module inside the More sheet has a badge. */
export function MoreDot({ mods, className, srText = true, dot = true }: { mods: Pick<ModuleDef, 'useBadge'>[]; className?: string; srText?: boolean; dot?: boolean }) {
  const hooks = mods.flatMap((m) => (m.useBadge ? [m.useBadge] : []));
  const total = useSecondaryTotal(hooks);
  if (total <= 0) return null;
  return (
    <>
      {srText && <span className="sr-only">, {total} new</span>}
      {dot && <span aria-hidden="true" className={cn('size-2.5 rounded-full bg-danger-solid ring-2 ring-surface', className)} />}
    </>
  );
}
